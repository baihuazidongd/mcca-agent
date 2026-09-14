// The shell opens a native window pointing at the portal (a localhost Node
// process) and auto-starts that process when needed, so the .exe works as a
// self-contained app. Business logic stays in Node; dsh/pi remain separate
// processes, so a crash in one does not take down the app.

use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

const PORTAL_ADDR: &str = "127.0.0.1:3470";

struct PortalChild(Mutex<Option<std::process::Child>>);

fn portal_reachable() -> bool {
    TcpStream::connect(PORTAL_ADDR).is_ok()
}

fn spawn_portal(app: &tauri::AppHandle) {
    if portal_reachable() {
        return; // already running (e.g. started by launch-pdb.ps1 or manually)
    }

    // Repo root = the ancestor of the exe that contains packages/portal.
    let root = std::env::current_exe()
        .ok()
        .and_then(|exe| {
            exe.ancestors()
                .find(|p| p.join("packages/portal/server.cjs").is_file())
                .map(|p| p.to_path_buf())
        })
        .or_else(|| {
            let cwd = std::env::current_dir().ok()?;
            cwd.join("packages/portal/server.cjs").is_file().then_some(cwd)
        });

    let Some(root) = root else {
        eprintln!("[pdb] packages/portal/server.cjs not found; cannot auto-start portal");
        return;
    };

    let mut cmd = std::process::Command::new("node");
    cmd.arg(root.join("packages/portal/server.cjs"))
        .current_dir(&root)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.spawn() {
        Ok(child) => {
            app.manage(PortalChild(Mutex::new(Some(child))));
            let handle = app.clone();
            std::thread::spawn(move || {
                for _ in 0..200 {
                    if portal_reachable() {
                        // The window already navigated to the (not yet ready)
                        // portal URL; reload it now that the server answers.
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.eval("location.reload()");
                        }
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            });
        }
        Err(e) => eprintln!("[pdb] failed to auto-start portal: {e}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            spawn_portal(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building pdb desktop")
        .run(|app_handle, event| {
            // If we spawned the portal, stop it when the app exits.
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<PortalChild>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}