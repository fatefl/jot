//! macOS：通过离屏 WKWebView 原生渲染导出 PDF。
//! WKWebView 不实现 window.print()（前端 iframe 打印在 macOS 上静默失败），
//! 但提供 printOperationWithPrintInfo:（macOS 10.15+）。配合
//! jobDisposition = Save + NSPrintJobSavingURL + 关闭打印/进度面板，
//! 由 WebKit 按打印纸型排版分页，静默输出矢量 PDF
//! （文字可选中，高亮/公式/图表完整保留，遵循 @page/@media print CSS）。
//!
//! 注：createPDFWithConfiguration: 输出的是整页连续长图式 PDF（不分页），
//! 对笔记导出不可用，故走 printOperation 路径。

use std::time::{Duration, Instant};

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::MainThreadOnly;
use objc2_app_kit::{NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob, NSWindow};
use objc2_foundation::{
    MainThreadMarker, NSPoint, NSRect, NSSize, NSString, NSURL,
};
use objc2_web_kit::{WKWebView, WKWebViewConfiguration};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

/// 导出超时上限（含页面加载与 PDF 渲染）。
const EXPORT_TIMEOUT: Duration = Duration::from_secs(20);
/// 加载完成后的短暂宽限，等内联 KaTeX 字体解码、Mermaid SVG 布局稳定。
const RENDER_GRACE: Duration = Duration::from_millis(300);
/// isLoading 轮询间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// 在主线程执行闭包并通过 oneshot 取回结果。
async fn run_on_main<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())
}

/// 创建离屏 WKWebView（挂在主窗口 contentView 可见区域外，保证 WebKit 正常排版），
/// 开始加载 HTML，返回裸指针（usize 以便跨线程传递；仅允许在主线程解引用）。
/// webview 由 superview 持有，remove_webview 前指针一直有效。
async fn create_webview(app: &AppHandle, html: String) -> Result<usize, String> {
    let app_handle = app.clone();
    run_on_main(app, move || {
        let mtm = MainThreadMarker::new().ok_or("不在主线程")?;
        let window = app_handle
            .get_webview_window("main")
            .ok_or("主窗口不存在")?;
        let ns_window = window.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
        let content_view = unsafe { (*ns_window).contentView() }.ok_or("主窗口无 contentView")?;

        // 分页按 NSPrintInfo 纸型（默认 Letter/A4），frame 仅决定布局宽度；
        // 放在可见区域下方，NSView 默认不裁剪子视图，不影响渲染。
        let frame = NSRect::new(NSPoint::new(0.0, -2000.0), NSSize::new(816.0, 1056.0));
        let config = unsafe { WKWebViewConfiguration::new(mtm) };
        let webview =
            unsafe { WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), frame, &config) };
        content_view.addSubview(&webview);
        unsafe {
            webview.loadHTMLString_baseURL(&NSString::from_str(&html), None);
        }
        let ptr = objc2::rc::Retained::into_raw(webview) as usize;
        Ok::<usize, String>(ptr)
    })
    .await?
}

/// 移除离屏 webview，并释放 create_webview 中 into_raw 泄漏的引用。
async fn remove_webview(app: &AppHandle, webview: usize) {
    let _ = run_on_main(app, move || {
        let webview = unsafe { objc2::rc::Retained::from_raw(webview as *mut WKWebView) };
        if let Some(webview) = webview {
            webview.removeFromSuperview();
        }
    })
    .await;
}

async fn is_loading(app: &AppHandle, webview: usize) -> Result<bool, String> {
    run_on_main(app, move || unsafe { (*(webview as *const WKWebView)).isLoading() }).await
}

/// 轮询等待页面加载完成。isLoading 在 loadHTMLString 返回后下一拍才置 true，
/// 先等它变 true（最多 2s），再等它回落为 false。
async fn wait_until_loaded(app: &AppHandle, webview: usize) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(2) {
        if is_loading(app, webview).await? {
            break;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
    while start.elapsed() < EXPORT_TIMEOUT {
        if !is_loading(app, webview).await? {
            tokio::time::sleep(RENDER_GRACE).await;
            return Ok(());
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
    Err("等待导出页面加载超时".to_string())
}

/// 通过 printOperation 按打印纸型分页渲染 PDF 并写入 dest_path。
/// 两个 WKWebView 打印的关键点（缺一会产生海量空白页或空文档）：
/// 1. 打印前必须把 webview 调整为 NSPrintInfo 纸型大小；
/// 2. 必须用 runOperationModalForWindow（驱动 runloop 让 WebKit 打印 IPC 进行），
///    不能用 runOperation。
/// modal 调用可能异步返回（打印在 runloop 中继续），
/// 因此以输出文件出现且大小稳定作为完成判据。
async fn render_pdf(app: &AppHandle, webview: usize, dest_path: String) -> Result<(), String> {
    let app_handle = app.clone();
    let dest = dest_path.clone();
    run_on_main(app, move || {
        let webview = unsafe { &*(webview as *const WKWebView) };
        let window = app_handle
            .get_webview_window("main")
            .ok_or("主窗口不存在")?;
        let ns_window = window.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;

        // 复制共享 NSPrintInfo，避免污染全局打印设置
        let print_info: Retained<NSPrintInfo> =
            unsafe { msg_send![&*NSPrintInfo::sharedPrintInfo(), copy] };
        // 静默保存为 PDF：输出到目标路径，不弹打印/进度面板
        print_info.setJobDisposition(unsafe { NSPrintSaveJob });
        let url = NSURL::fileURLWithPath(&NSString::from_str(&dest));
        let dict = unsafe { print_info.dictionary() };
        let _: () = unsafe { msg_send![&*dict, setObject: &*url, forKey: NSPrintJobSavingURL] };

        let op = unsafe { webview.printOperationWithPrintInfo(&print_info) };
        // 关键点 1：webview 尺寸 = 纸型；origin 保持在窗口可见区域外
        let paper = print_info.paperSize();
        webview.setFrame(NSRect::new(NSPoint::new(0.0, -2000.0), paper));
        op.setShowsPrintPanel(false);
        op.setShowsProgressPanel(false);
        // 关键点 2：modal 变体（delegate 传空）；应用主 runloop 会驱动打印至完成
        unsafe {
            op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                &*ns_window,
                None,
                None,
                std::ptr::null_mut(),
            );
        }
        Ok::<(), String>(())
    })
    .await??;

    // 等输出文件出现且大小稳定（应用事件循环驱动打印 IPC，此处只需轮询文件）
    let deadline = Instant::now() + EXPORT_TIMEOUT;
    let mut last_len = None;
    let mut stable = 0;
    loop {
        let len = std::fs::metadata(&dest_path).ok().map(|m| m.len());
        match len {
            Some(l) if l > 0 && Some(l) == last_len => {
                stable += 1;
                if stable >= 4 {
                    return Ok(());
                }
            }
            _ => {
                stable = 0;
                last_len = len;
            }
        }
        if Instant::now() >= deadline {
            return Err("PDF 未生成或为空".to_string());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// 运行原生打印面板：把渲染好的离屏 webview 交给 NSPrintOperation，
/// 弹出可交互的打印对话框（选打印机/份数/“存储为 PDF”）。
/// 与导出 PDF 的区别：不设 NSPrintSaveJob、打开打印面板。
async fn show_print_panel(app: &AppHandle, webview: usize) -> Result<(), String> {
    let app_handle = app.clone();
    run_on_main(app, move || {
        let webview = unsafe { &*(webview as *const WKWebView) };
        let window = app_handle
            .get_webview_window("main")
            .ok_or("主窗口不存在")?;
        let ns_window = window.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;

        // 复制共享 NSPrintInfo；jobDisposition 保持默认（打印到打印机）
        let print_info: Retained<NSPrintInfo> =
            unsafe { msg_send![&*NSPrintInfo::sharedPrintInfo(), copy] };
        let op = unsafe { webview.printOperationWithPrintInfo(&print_info) };

        // 关键点：webview 尺寸 = 纸型；origin 保持在窗口可见区域外
        let paper = print_info.paperSize();
        webview.setFrame(NSRect::new(NSPoint::new(0.0, -2000.0), paper));

        // 打开打印面板 + 进度面板。modal 变体驱动 runloop（不能用 runOperation），
        // 面板显示期间主线程处于 modal runloop，用户打印/取消后返回
        op.setShowsPrintPanel(true);
        op.setShowsProgressPanel(true);
        unsafe {
            op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                &*ns_window,
                None,
                None,
                std::ptr::null_mut(),
            );
        }
        Ok::<(), String>(())
    })
    .await??;
    Ok(())
}

/// macOS：将 HTML 渲染到离屏 WKWebView 并弹出原生打印面板。
/// WKWebView 不实现 window.print()（前端 iframe 打印静默失败），
/// 与导出 PDF 一样走 printOperation，区别是打开打印面板而非静默存盘。
/// 面板交互时长由用户决定，不做超时；wait_until_loaded 内部有 20s 加载上限兜底。
#[tauri::command]
pub async fn print_native(app: AppHandle, html: String) -> Result<(), String> {
    let webview = create_webview(&app, html).await?;

    let result = async {
        wait_until_loaded(&app, webview).await?;
        show_print_panel(&app, webview).await
    }
    .await;

    // 面板关闭后打印任务仍可能在 runloop 中异步进行，宽限后再移除 webview
    tokio::time::sleep(Duration::from_secs(2)).await;
    remove_webview(&app, webview).await;
    result
}

/// 将自包含 HTML 渲染为 PDF 写入 dest_path（仅 macOS）。
#[tauri::command]
pub async fn export_pdf_native(
    app: AppHandle,
    html: String,
    dest_path: String,
) -> Result<(), String> {
    let webview = create_webview(&app, html).await?;

    let result = async {
        wait_until_loaded(&app, webview).await?;
        render_pdf(&app, webview, dest_path).await
    };
    let result = match tokio::time::timeout(EXPORT_TIMEOUT, result).await {
        Ok(r) => r,
        Err(_) => Err("导出 PDF 超时".to_string()),
    };

    remove_webview(&app, webview).await;
    result
}
