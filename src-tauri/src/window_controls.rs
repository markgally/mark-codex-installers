use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow};
use tokio::sync::Mutex;

#[derive(Clone)]
struct WindowSnapshot {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    minimum: Option<LogicalSize<f64>>,
    fullscreen: bool,
    maximized: bool,
    resizable: bool,
    always_on_top: bool,
}

#[derive(Default)]
pub(crate) struct WindowState {
    compact: AtomicBool,
    original: Mutex<Option<WindowSnapshot>>,
}

impl WindowState {
    pub fn is_compact(&self) -> bool {
        self.compact.load(Ordering::SeqCst)
    }
}

// Monitor work areas already exclude the menu bar, taskbar, and Dock.
// All calculations use physical pixels, including monitors left of the primary.
fn compact_geometry(
    x: i32, y: i32, width: u32, height: u32, scale: f64,
) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let gap = ((16.0 * scale).round() as u32).min(width / 4).min(height / 4);
    let compact_width = ((360.0 * scale).round() as u32)
        .min(width.saturating_sub(gap * 2)).max(1);
    let compact_height = ((480.0 * scale).round() as u32)
        .min(height.saturating_sub(gap * 2)).max(1);
    let position = PhysicalPosition::new(
        (i64::from(x) + i64::from(width) - i64::from(compact_width) - i64::from(gap))
            .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        (i64::from(y) + i64::from(height) - i64::from(compact_height) - i64::from(gap))
            .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
    );
    (position, PhysicalSize::new(compact_width, compact_height))
}

fn capture(app: &AppHandle, window: &WebviewWindow) -> tauri::Result<WindowSnapshot> {
    let minimum = app.config().app.windows.iter()
        .find(|config| config.label == window.label())
        .and_then(|config| {
            (config.min_width.is_some() || config.min_height.is_some())
                .then(|| LogicalSize::new(config.min_width.unwrap_or(0.0), config.min_height.unwrap_or(0.0)))
        });
    Ok(WindowSnapshot {
        position: window.outer_position()?,
        size: window.inner_size()?,
        minimum,
        fullscreen: window.is_fullscreen()?,
        maximized: window.is_maximized()?,
        resizable: window.is_resizable()?,
        always_on_top: window.is_always_on_top()?,
    })
}

async fn leave_fullscreen(window: &WebviewWindow) -> Result<(), String> {
    if window.is_fullscreen().map_err(|error| error.to_string())? {
        window.set_fullscreen(false).map_err(|error| error.to_string())?;
        for _ in 0..20 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            if !window.is_fullscreen().map_err(|error| error.to_string())? {
                // Give macOS time to finish its fullscreen Space transition.
                tokio::time::sleep(std::time::Duration::from_millis(350)).await;
                return Ok(());
            }
        }
        return Err("The window is still leaving fullscreen. Try again.".to_owned());
    }
    Ok(())
}

async fn restore(window: &WebviewWindow, saved: &WindowSnapshot) -> Result<(), String> {
    leave_fullscreen(window).await?;
    if window.is_maximized().map_err(|error| error.to_string())? {
        window.unmaximize().map_err(|error| error.to_string())?;
    }
    window.set_resizable(saved.resizable).map_err(|error| error.to_string())?;
    window.set_min_size(saved.minimum).map_err(|error| error.to_string())?;
    window.set_size(saved.size).map_err(|error| error.to_string())?;
    window.set_position(saved.position).map_err(|error| error.to_string())?;
    window.set_always_on_top(saved.always_on_top).map_err(|error| error.to_string())?;
    if saved.maximized {
        window.maximize().map_err(|error| error.to_string())?;
    }
    if saved.fullscreen {
        window.set_fullscreen(true).map_err(|error| error.to_string())?;
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn window_is_compact(state: State<'_, WindowState>) -> bool {
    state.is_compact()
}

#[tauri::command]
pub(crate) fn minimize_or_hide_window(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("The main window is unavailable")?;
    #[cfg(target_os = "windows")]
    let result = window.minimize();
    #[cfg(not(target_os = "windows"))]
    let result = window.hide();
    result.map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn toggle_window_mode(
    app: AppHandle, state: State<'_, WindowState>,
) -> Result<bool, String> {
    let window = app.get_webview_window("main").ok_or("The main window is unavailable")?;
    let mut original = state.original.lock().await;
    if let Some(saved) = original.as_ref() {
        restore(&window, saved).await?;
        *original = None;
        state.compact.store(false, Ordering::SeqCst);
        let _ = window.emit("window-mode-changed", false);
        return Ok(false);
    }

    let saved = capture(&app, &window).map_err(|error| error.to_string())?;
    let monitor = window.current_monitor().map_err(|error| error.to_string())?
        .or(window.primary_monitor().map_err(|error| error.to_string())?)
        .ok_or("No display is available")?;
    let area = monitor.work_area();
    let (position, size) = compact_geometry(
        area.position.x, area.position.y, area.size.width, area.size.height, monitor.scale_factor(),
    );
    let changed: Result<(), String> = async {
        leave_fullscreen(&window).await?;
        if saved.maximized {
            window.unmaximize().map_err(|error| error.to_string())?;
        }
        window.set_min_size(None::<LogicalSize<f64>>).map_err(|error| error.to_string())?;
        window.set_resizable(false).map_err(|error| error.to_string())?;
        window.set_size(size).map_err(|error| error.to_string())?;
        window.set_position(position).map_err(|error| error.to_string())?;
        window.set_always_on_top(true).map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        Ok(())
    }.await;
    if let Err(error) = changed {
        let _ = restore(&window, &saved).await;
        return Err(error);
    }
    *original = Some(saved);
    state.compact.store(true, Ordering::SeqCst);
    let _ = window.emit("window-mode-changed", true);
    Ok(true)
}

#[tauri::command]
pub(crate) fn quit_application(app: AppHandle) {
    crate::request_application_exit(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_window_uses_the_available_desktop_above_the_dock() {
        let (position, size) = compact_geometry(0, 25, 1440, 820, 1.0);
        assert_eq!(size, PhysicalSize::new(360, 480));
        assert_eq!(position, PhysicalPosition::new(1064, 349));
        assert_eq!(position.y + size.height as i32 + 16, 845);
    }

    #[test]
    fn retina_displays_keep_the_same_logical_size_and_margin() {
        let (position, size) = compact_geometry(0, 50, 2880, 1640, 2.0);
        assert_eq!(size, PhysicalSize::new(720, 960));
        assert_eq!(position, PhysicalPosition::new(2128, 698));
    }

    #[test]
    fn monitors_left_of_the_primary_keep_negative_coordinates() {
        let (position, size) = compact_geometry(-1920, -100, 1920, 1040, 1.0);
        assert_eq!(size, PhysicalSize::new(360, 480));
        assert_eq!(position, PhysicalPosition::new(-376, 444));
    }

    #[test]
    fn small_work_areas_keep_the_entire_window_on_screen() {
        let (position, size) = compact_geometry(100, 200, 320, 240, 1.0);
        assert_eq!(position, PhysicalPosition::new(116, 216));
        assert_eq!(size, PhysicalSize::new(288, 208));
        assert!(position.x >= 100 && position.y >= 200);
        assert!(position.x + size.width as i32 <= 420);
        assert!(position.y + size.height as i32 <= 440);
    }
}
