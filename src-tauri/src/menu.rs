use std::sync::Mutex;

use serde_json::json;
use tauri::{
    menu::{
        CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuEvent, MenuItemBuilder,
        PredefinedMenuItem, SubmenuBuilder,
    },
    AppHandle, Emitter, Manager, Wry,
};

/// 暗色模式菜单项的句柄，供事件处理时同步复选框状态
static DARK_MODE_ITEM: Mutex<Option<CheckMenuItem<Wry>>> = Mutex::new(None);

/// 构建全局菜单栏。每个菜单项的 id 对应前端 menu-action 事件的 action 字段。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn build_menu(handle: &AppHandle) -> Result<tauri::menu::Menu<Wry>, tauri::Error> {
    // ── 文件 ──────────────────────────────────────────────
    let new_note = MenuItemBuilder::with_id("new_note", "新建笔记")
        .accelerator("CmdOrCtrl+N")
        .build(handle)?;
    let new_folder = MenuItemBuilder::with_id("new_folder", "新建文件夹").build(handle)?;
    let save = MenuItemBuilder::with_id("save", "保存")
        .accelerator("CmdOrCtrl+S")
        .build(handle)?;
    let save_as = MenuItemBuilder::with_id("save_as", "另存为...")
        .accelerator("CmdOrCtrl+Shift+S")
        .build(handle)?;
    let open_notes_dir =
        MenuItemBuilder::with_id("open_notes_dir", "打开笔记目录...").build(handle)?;
    let open_file = MenuItemBuilder::with_id("open_file", "打开文件...")
        .accelerator("CmdOrCtrl+O")
        .build(handle)?;
    let import_files =
        MenuItemBuilder::with_id("import_files", "导入文件...").build(handle)?;
    let print = MenuItemBuilder::with_id("print", "打印")
        .accelerator("CmdOrCtrl+P")
        .build(handle)?;
    let settings = MenuItemBuilder::with_id("settings", "设置...")
        .accelerator("CmdOrCtrl+,")
        .build(handle)?;

    // 导出子菜单
    let export_html = MenuItemBuilder::with_id("export_html", "HTML").build(handle)?;
    let export_pdf = MenuItemBuilder::with_id("export_pdf", "PDF").build(handle)?;
    let export_png = MenuItemBuilder::with_id("export_png", "PNG 图片").build(handle)?;
    let export_docx = MenuItemBuilder::with_id("export_docx", "DOCX").build(handle)?;
    let export_epub = MenuItemBuilder::with_id("export_epub", "EPUB").build(handle)?;
    let export_latex = MenuItemBuilder::with_id("export_latex", "LaTeX").build(handle)?;

    let export_menu = SubmenuBuilder::new(handle, "导出")
        .item(&export_html)
        .item(&export_pdf)
        .item(&export_png)
        .separator()
        .item(&export_docx)
        .item(&export_epub)
        .item(&export_latex)
        .build()?;

    let file_menu = SubmenuBuilder::new(handle, "文件")
        .item(&new_note)
        .item(&new_folder)
        .separator()
        .item(&save)
        .item(&save_as)
        .separator()
        .item(&open_notes_dir)
        .separator()
        .item(&open_file)
        .item(&import_files)
        .item(&export_menu)
        .separator()
        .item(&print)
        .separator()
        .item(&settings)
        .separator()
        .item(&PredefinedMenuItem::quit(handle, Some("退出"))?)
        .build()?;

    // ── 编辑 ──────────────────────────────────────────────
    let command_palette = MenuItemBuilder::with_id("command_palette", "命令面板...")
        .accelerator("CmdOrCtrl+Shift+K")
        .build(handle)?;
    let find = MenuItemBuilder::with_id("find", "查找").build(handle)?;
    let undo_item = MenuItemBuilder::with_id("undo", "撤销")
        .accelerator("CmdOrCtrl+Z")
        .build(handle)?;
    let redo_item = MenuItemBuilder::with_id("redo", "重做")
        .accelerator("CmdOrCtrl+Shift+Z")
        .build(handle)?;

    let edit_menu = SubmenuBuilder::new(handle, "编辑")
        .item(&undo_item)
        .item(&redo_item)
        .separator()
        .item(&PredefinedMenuItem::cut(handle, Some("剪切"))?)
        .item(&PredefinedMenuItem::copy(handle, Some("复制"))?)
        .item(&PredefinedMenuItem::paste(handle, Some("粘贴"))?)
        .item(&PredefinedMenuItem::select_all(handle, Some("全选"))?)
        .separator()
        .item(&command_palette)
        .item(&find)
        .build()?;

    // ── 格式 ──────────────────────────────────────────────
    let format_bold = MenuItemBuilder::with_id("format_bold", "加粗")
        .accelerator("CmdOrCtrl+B")
        .build(handle)?;
    let format_italic = MenuItemBuilder::with_id("format_italic", "斜体")
        .accelerator("CmdOrCtrl+I")
        .build(handle)?;
    let format_strikethrough =
        MenuItemBuilder::with_id("format_strikethrough", "删除线").build(handle)?;
    let format_inline_code = MenuItemBuilder::with_id("format_inline_code", "行内代码")
        .accelerator("CmdOrCtrl+E")
        .build(handle)?;
    let format_link = MenuItemBuilder::with_id("format_link", "链接")
        .accelerator("CmdOrCtrl+K")
        .build(handle)?;

    // 标题子菜单
    let heading_1 =
        MenuItemBuilder::with_id("format_heading_1", "一级标题").build(handle)?;
    let heading_2 =
        MenuItemBuilder::with_id("format_heading_2", "二级标题").build(handle)?;
    let heading_3 =
        MenuItemBuilder::with_id("format_heading_3", "三级标题").build(handle)?;
    let heading_menu = SubmenuBuilder::new(handle, "标题")
        .item(&heading_1)
        .item(&heading_2)
        .item(&heading_3)
        .build()?;

    // 列表子菜单
    let bullet_list =
        MenuItemBuilder::with_id("format_bullet_list", "无序列表").build(handle)?;
    let ordered_list =
        MenuItemBuilder::with_id("format_ordered_list", "有序列表").build(handle)?;
    let task_list =
        MenuItemBuilder::with_id("format_task_list", "任务列表").build(handle)?;
    let list_menu = SubmenuBuilder::new(handle, "列表")
        .item(&bullet_list)
        .item(&ordered_list)
        .item(&task_list)
        .build()?;

    let format_blockquote =
        MenuItemBuilder::with_id("format_blockquote", "引用").build(handle)?;
    let format_code_block =
        MenuItemBuilder::with_id("format_code_block", "代码块").build(handle)?;

    // 插入子菜单
    let insert_table =
        MenuItemBuilder::with_id("format_insert_table", "表格").build(handle)?;
    let insert_hr =
        MenuItemBuilder::with_id("format_hr", "分割线").build(handle)?;
    let insert_emoji =
        MenuItemBuilder::with_id("format_emoji", "表情符号...").build(handle)?;
    let insert_menu = SubmenuBuilder::new(handle, "插入")
        .item(&insert_table)
        .item(&insert_hr)
        .separator()
        .item(&insert_emoji)
        .build()?;

    let format_menu = SubmenuBuilder::new(handle, "格式")
        .item(&format_bold)
        .item(&format_italic)
        .item(&format_strikethrough)
        .item(&format_inline_code)
        .item(&format_link)
        .separator()
        .item(&heading_menu)
        .item(&list_menu)
        .item(&format_blockquote)
        .item(&format_code_block)
        .separator()
        .item(&insert_menu)
        .build()?;

    // ── 视图 ──────────────────────────────────────────────
    let toggle_sidebar = MenuItemBuilder::with_id("toggle_sidebar", "切换侧边栏")
        .accelerator("CmdOrCtrl+\\")
        .build(handle)?;
    let toggle_live_preview = MenuItemBuilder::with_id("toggle_live_preview", "切换即时渲染")
        .accelerator("CmdOrCtrl+Shift+P")
        .build(handle)?;
    let zoom_in = MenuItemBuilder::with_id("zoom_in", "放大").build(handle)?;
    let zoom_out = MenuItemBuilder::with_id("zoom_out", "缩小").build(handle)?;
    let zoom_reset = MenuItemBuilder::with_id("zoom_reset", "重置缩放").build(handle)?;
    let dark_mode = CheckMenuItemBuilder::with_id("dark_mode", "暗色模式").build(handle)?;

    // 保存句柄，供事件处理时同步勾选状态
    *DARK_MODE_ITEM.lock().unwrap() = Some(dark_mode.clone());

    let view_menu = SubmenuBuilder::new(handle, "视图")
        .item(&toggle_sidebar)
        .item(&toggle_live_preview)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .separator()
        .item(&dark_mode)
        .build()?;

    // ── 同步 ──────────────────────────────────────────────
    let sync_now = MenuItemBuilder::with_id("sync_now", "立即同步").build(handle)?;
    let commit_all = MenuItemBuilder::with_id("commit_all", "提交所有更改").build(handle)?;
    let sync_settings =
        MenuItemBuilder::with_id("sync_settings", "同步设置...").build(handle)?;

    let sync_menu = SubmenuBuilder::new(handle, "同步")
        .item(&sync_now)
        .item(&commit_all)
        .separator()
        .item(&sync_settings)
        .build()?;

    // ── 帮助 ──────────────────────────────────────────────
    let about = MenuItemBuilder::with_id("about", "关于 即记 (Jot)").build(handle)?;
    let user_agreement =
        MenuItemBuilder::with_id("user_agreement", "用户协议").build(handle)?;
    let privacy_policy =
        MenuItemBuilder::with_id("privacy_policy", "隐私政策").build(handle)?;
    let mcp_guide =
        MenuItemBuilder::with_id("mcp_guide", "MCP 配置指南").build(handle)?;

    let help_menu = SubmenuBuilder::new(handle, "帮助")
        .item(&about)
        .separator()
        .item(&user_agreement)
        .item(&privacy_policy)
        .separator()
        .item(&mcp_guide)
        .build()?;

    // ── 组装菜单栏 ───────────────────────────────────────
    let menu = MenuBuilder::new(handle)
        .items(&[&file_menu, &edit_menu, &format_menu, &view_menu, &sync_menu, &help_menu])
        .build()?;

    Ok(menu)
}

/// 分发菜单事件到前端。
/// PredefinedMenuItem（剪切/复制/粘贴/全选/退出）由 Tauri 内部处理，
/// 不会走到这里；只有自定义 MenuItem / CheckMenuItem 的点击事件会触发此函数。
pub fn handle_menu_event(app_handle: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref().to_string();

    // 暗色模式：先同步复选框勾选状态，再通知前端
    if id == "dark_mode" {
        if let Ok(guard) = DARK_MODE_ITEM.lock() {
            if let Some(ref item) = *guard {
                let current = item.is_checked().unwrap_or(false);
                let _ = item.set_checked(!current);
            }
        }
    }

    let action = match id.as_str() {
        "undo" => "undo",
        "redo" => "redo",
        "new_note" => "newNote",
        "new_folder" => "newFolder",
        "save" => "save",
        "save_as" => "saveAs",
        "open_notes_dir" => "openNotesDir",
        "open_file" => "openFile",
        "import_files" => "importFiles",
        "export_html" => "exportHtml",
        "export_pdf" => "exportPdf",
        "export_png" => "exportPng",
        "export_docx" => "exportDocx",
        "export_epub" => "exportEpub",
        "export_latex" => "exportLatex",
        "print" => "print",
        "settings" => "openSettings",
        "find" => "find",
        "command_palette" => "commandPalette",
        "toggle_sidebar" => "toggleSidebar",
        "toggle_live_preview" => "toggleLivePreview",
        "zoom_in" => "zoomIn",
        "zoom_out" => "zoomOut",
        "zoom_reset" => "zoomReset",
        "dark_mode" => "toggleDarkMode",
        "format_bold" => "formatBold",
        "format_italic" => "formatItalic",
        "format_strikethrough" => "formatStrikethrough",
        "format_inline_code" => "formatInlineCode",
        "format_link" => "formatLink",
        "format_heading_1" => "formatHeading1",
        "format_heading_2" => "formatHeading2",
        "format_heading_3" => "formatHeading3",
        "format_bullet_list" => "formatBulletList",
        "format_ordered_list" => "formatOrderedList",
        "format_task_list" => "formatTaskList",
        "format_blockquote" => "formatBlockquote",
        "format_code_block" => "formatCodeBlock",
        "format_insert_table" => "formatInsertTable",
        "format_hr" => "formatHorizontalRule",
        "format_emoji" => "formatEmoji",
        "sync_now" => "syncNow",
        "commit_all" => "commitAll",
        "sync_settings" => "syncSettings",
        "about" => "about",
        "user_agreement" => "userAgreement",
        "privacy_policy" => "privacyPolicy",
        "mcp_guide" => "mcpGuide",
        _ => {
            eprintln!("[menu] unhandled id: {}", id);
            return;
        }
    };

    eprintln!("[menu] clicked: {} → action: {}", id, action);
    let payload = json!({ "action": action });

    // 直接向主窗口发送事件
    if let Some(w) = app_handle.get_webview_window("main") {
        let _ = w.emit("menu-action", payload);
    } else {
        let _ = app_handle.emit("menu-action", payload);
    }
}
