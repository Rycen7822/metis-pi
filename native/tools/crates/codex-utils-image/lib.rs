use std::io::Cursor;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use image::ColorType;
use image::DynamicImage;
use image::GenericImageView;
use image::ImageDecoder;
use image::ImageEncoder;
use image::ImageFormat;
use image::ImageReader;
use image::codecs::png::PngEncoder;

pub mod error;
pub use crate::error::ImageProcessingError;

#[derive(Debug)]
pub struct EncodedImage {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub width: u32,
    pub height: u32,
}

impl EncodedImage {
    pub fn into_data_url(self) -> String {
        let encoded = BASE64_STANDARD.encode(&self.bytes);
        format!("data:{};base64,{encoded}", self.mime)
    }
}

/// Validate an original image, preserving supported source bytes without resizing.
/// GIF input is converted to a PNG of the same dimensions.
pub fn load_for_prompt_bytes(
    path: &Path,
    file_bytes: Vec<u8>,
) -> Result<EncodedImage, ImageProcessingError> {
    let format = image::guess_format(&file_bytes)
        .map_err(|source| ImageProcessingError::decode_error(path, source))?;
    let mut decoder = ImageReader::with_format(Cursor::new(&file_bytes), format)
        .into_decoder()
        .map_err(|source| ImageProcessingError::decode_error(path, source))?;
    let icc_profile = decoder
        .icc_profile()
        .ok()
        .flatten()
        .filter(|profile| profile.get(16..20) == Some(b"RGB "));
    let exif = decoder.exif_metadata().ok().flatten();
    let dynamic = DynamicImage::from_decoder(decoder)
        .map_err(|source| ImageProcessingError::decode_error(path, source))?;
    let (width, height) = dynamic.dimensions();

    if matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        let mime = match format {
            ImageFormat::Jpeg => "image/jpeg",
            ImageFormat::WebP => "image/webp",
            _ => "image/png",
        };
        return Ok(EncodedImage {
            bytes: file_bytes,
            mime: mime.into(),
            width,
            height,
        });
    }

    let rgba = dynamic.to_rgba8();
    let mut bytes = Vec::new();
    let mut encoder = PngEncoder::new(&mut bytes);
    if let Some(profile) = icc_profile {
        encoder
            .set_icc_profile(profile)
            .map_err(|source| ImageProcessingError::Encode {
                format: ImageFormat::Png,
                source: image::ImageError::Unsupported(source),
            })?;
    }
    if let Some(exif) = exif {
        encoder
            .set_exif_metadata(exif)
            .map_err(|source| ImageProcessingError::Encode {
                format: ImageFormat::Png,
                source: image::ImageError::Unsupported(source),
            })?;
    }
    encoder
        .write_image(rgba.as_raw(), width, height, ColorType::Rgba8.into())
        .map_err(|source| ImageProcessingError::Encode {
            format: ImageFormat::Png,
            source,
        })?;
    Ok(EncodedImage {
        bytes,
        mime: "image/png".into(),
        width,
        height,
    })
}

#[cfg(test)]
#[path = "image_tests.rs"]
mod tests;
