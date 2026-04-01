use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use screenshots::Screen;
use screenshots::image::{DynamicImage, ImageFormat};
use std::io::Cursor;

const MIN_SELECTION_SIZE: i32 = 8;

#[derive(Debug, Clone, Copy)]
pub struct OcrRegion {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl OcrRegion {
    pub fn width(self) -> i32 {
        self.right - self.left
    }

    pub fn height(self) -> i32 {
        self.bottom - self.top
    }

    pub fn center(self) -> (i32, i32) {
        (self.left + self.width() / 2, self.top + self.height() / 2)
    }
}

pub fn normalize_region(left: i32, top: i32, right: i32, bottom: i32) -> Option<OcrRegion> {
    let normalized = OcrRegion {
        left: left.min(right),
        top: top.min(bottom),
        right: left.max(right),
        bottom: top.max(bottom),
    };

    if normalized.width() < MIN_SELECTION_SIZE || normalized.height() < MIN_SELECTION_SIZE {
        return None;
    }

    Some(normalized)
}

fn find_screen_for_center(center_x: i32, center_y: i32) -> Result<Screen, String> {
    let screens = Screen::all().map_err(|err| format!("list screens failed: {err}"))?;
    if screens.is_empty() {
        return Err("no screen available".to_owned());
    }

    let mut nearest: Option<(i64, Screen)> = None;

    for screen in screens {
        let info = screen.display_info;
        let left = info.x;
        let top = info.y;
        let right = info.x + info.width as i32;
        let bottom = info.y + info.height as i32;

        if center_x >= left && center_x <= right && center_y >= top && center_y <= bottom {
            return Ok(screen);
        }

        let cx = left + (right - left) / 2;
        let cy = top + (bottom - top) / 2;
        let distance = i64::from((center_x - cx).abs() + (center_y - cy).abs());
        match nearest {
            Some((best, _)) if distance >= best => {}
            _ => nearest = Some((distance, screen)),
        }
    }

    nearest
        .map(|(_, screen)| screen)
        .ok_or_else(|| "no matching screen found".to_owned())
}

pub fn capture_region_png_base64(region: OcrRegion) -> Result<String, String> {
    let (center_x, center_y) = region.center();
    let screen = find_screen_for_center(center_x, center_y)?;
    let info = screen.display_info;

    let mon_left = info.x;
    let mon_top = info.y;
    let mon_right = info.x + info.width as i32;
    let mon_bottom = info.y + info.height as i32;

    let clipped_left = region.left.clamp(mon_left, mon_right);
    let clipped_top = region.top.clamp(mon_top, mon_bottom);
    let clipped_right = region.right.clamp(mon_left, mon_right);
    let clipped_bottom = region.bottom.clamp(mon_top, mon_bottom);

    let clipped_width = (clipped_right - clipped_left).max(0);
    let clipped_height = (clipped_bottom - clipped_top).max(0);
    if clipped_width < MIN_SELECTION_SIZE || clipped_height < MIN_SELECTION_SIZE {
        return Err("selected region is too small".to_owned());
    }

    let local_x = clipped_left - mon_left;
    let local_y = clipped_top - mon_top;

    let image = screen
        .capture_area(local_x, local_y, clipped_width as u32, clipped_height as u32)
        .map_err(|err| format!("capture area failed: {err}"))?;

    let mut bytes: Vec<u8> = Vec::new();
    DynamicImage::ImageRgba8(image)
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .map_err(|err| format!("encode screenshot failed: {err}"))?;

    Ok(BASE64_STANDARD.encode(bytes))
}