pub mod index;
pub mod transcript;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
