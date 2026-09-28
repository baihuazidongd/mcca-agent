// The shell opens a native window pointing at the portal (a localhost Node
// process) and auto-starts that process when needed, so the .exe works as a
// self-contained app. Business logic stays in Node; dsh/pi remain separate
// processes, so a crash in one does not take down the app.

use std::net::TcpStream;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

const PORTAL_ADDR: &str = "127.0.0.1:3470";

struct PortalChild(Mutex<Option<std::process::Child>>);

fn portal_reachable() -> bool {
    let Ok(addr) = PORTAL_ADDR.parse() else { return false; };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else { return false; };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    if stream.write_all(b"GET /api/runtimes HTTP/1.1\r\nHost: 127.0.0.1:3470\r\nConnection: close\r\n\r\n").is_err() { return false; }
    let mut response = String::new();
    if stream.take(131072).read_to_string(&mut response).is_err() { return false; }
    response.starts_with("HTTP/1.1 200") && response.contains("\"runtimes\"") && response.contains("\"ok\":true")
}

fn spawn_portal(app: &tauri::AppHandle) {
    if portal_reachable() {
        return; // already running (e.g. started by launch-mcca.ps1 or manually)
    }
    if TcpStream::connect(PORTAL_ADDR).is_ok() {
        eprintln!("[mcca] port 3470 is occupied by an incompatible or unready portal; no duplicate process started");
        return;
    }

    // Repo root = the ancestor of the exe that contains packages/portal.
    let root = std::env::var_os("MCCA_HOME")
        .map(std::path::PathBuf::from)
        .filter(|p| p.join("packages/portal/server.cjs").is_file())
        .or_else(|| std::env::current_exe()
        .ok()
        .and_then(|exe| {
            exe.ancestors()
                .find(|p| p.join("packages/portal/server.cjs").is_file())
                .map(|p| p.to_path_buf())
        }))
        .or_else(|| {
            let cwd = std::env::current_dir().ok()?;
            cwd.join("packages/portal/server.cjs").is_file().then_some(cwd)
        });

    let Some(root) = root else {
        eprintln!("[mcca] packages/portal/server.cjs not found; cannot auto-start portal");
        return;
    };

    let bundled_node = root.join("runtime/node.exe");
    let node = std::env::var_os("MCCA_NODE").map(std::path::PathBuf::from)
        .unwrap_or_else(|| if bundled_node.is_file() { bundled_node } else { "node".into() });
    let mut cmd = std::process::Command::new(node);
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
        Err(e) => eprintln!("[mcca] failed to auto-start portal: {e}"),
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
        .expect("error while building mcca desktop")
        .run(|_app_handle, _event| {
            // 关掉窗口不结束门户，也不结束它拉起的 IDE。
            // 门户和 IDE 都脱离了这个窗口，下次打开再接上还在跑的进程。
        });
}
