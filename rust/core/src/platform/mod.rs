//! Operating-system specific pieces. Windows gets the real implementation (raw Win32 calls, no
//! extra libraries); other systems get simple stand-ins used for development and tests.

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;

#[cfg(not(windows))]
mod other;
#[cfg(not(windows))]
pub use self::other::*;
