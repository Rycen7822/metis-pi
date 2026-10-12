use std::io::Cursor;

use super::*;
use image::ImageBuffer;
use image::Rgba;

fn image_bytes(image: &ImageBuffer<Rgba<u8>, Vec<u8>>, format: ImageFormat) -> Vec<u8> {
    let mut encoded = Cursor::new(Vec::new());
    let dynamic = DynamicImage::ImageRgba8(image.clone());
    let dynamic = if format == ImageFormat::Jpeg {
        DynamicImage::ImageRgb8(dynamic.into_rgb8())
    } else {
        dynamic
    };
    dynamic
        .write_to(&mut encoded, format)
        .expect("encode fixture");
    encoded.into_inner()
}

#[test]
fn preserves_supported_source_bytes() {
    for (format, mime) in [
        (ImageFormat::Png, "image/png"),
        (ImageFormat::Jpeg, "image/jpeg"),
        (ImageFormat::WebP, "image/webp"),
    ] {
        let image = ImageBuffer::from_pixel(64, 32, Rgba([10u8, 20, 30, 255]));
        let original_bytes = image_bytes(&image, format);
        let encoded = load_for_prompt_bytes(Path::new("original-image"), original_bytes.clone())
            .expect("validate original");
        assert_eq!((encoded.width, encoded.height), (64, 32));
        assert_eq!(encoded.mime, mime);
        assert_eq!(encoded.bytes, original_bytes);

        let data_url = encoded.into_data_url();
        let payload = data_url
            .strip_prefix(&format!("data:{mime};base64,"))
            .expect("MIME data URL");
        assert_eq!(
            BASE64_STANDARD.decode(payload).expect("base64 payload"),
            original_bytes
        );
    }
}

#[test]
fn preserves_large_original_dimensions_and_bytes() {
    let image = ImageBuffer::from_pixel(4096, 2, Rgba([180u8, 30, 30, 255]));
    let original_bytes = image_bytes(&image, ImageFormat::Png);
    let encoded = load_for_prompt_bytes(Path::new("large-original"), original_bytes.clone())
        .expect("validate large original");
    assert_eq!((encoded.width, encoded.height), (4096, 2));
    assert_eq!(encoded.bytes, original_bytes);
}

#[test]
fn converts_gif_to_png_without_resizing() {
    let pixel = Rgba([10u8, 20, 30, 255]);
    let image = ImageBuffer::from_pixel(64, 32, pixel);
    let encoded = load_for_prompt_bytes(
        Path::new("image.gif"),
        image_bytes(&image, ImageFormat::Gif),
    )
    .expect("convert GIF");
    assert_eq!(encoded.mime, "image/png");
    assert_eq!(
        image::guess_format(&encoded.bytes).expect("output format"),
        ImageFormat::Png
    );
    let decoded = image::load_from_memory(&encoded.bytes).expect("decode PNG");
    assert_eq!(decoded.dimensions(), (64, 32));
    assert_eq!(decoded.get_pixel(0, 0), pixel);
}

#[test]
fn fails_cleanly_for_invalid_images() {
    let error = load_for_prompt_bytes(Path::new("invalid-image"), b"not an image".to_vec())
        .expect_err("invalid input");
    assert!(matches!(
        error,
        ImageProcessingError::Decode { .. } | ImageProcessingError::UnsupportedImageFormat { .. }
    ));
}
