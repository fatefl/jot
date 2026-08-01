mod fs;
mod tools;

use std::sync::Arc;

use clap::Parser;
use model_context_protocol::server::stdio::McpStdioServer;
use model_context_protocol::tool::{BoxFuture, FnTool, ToolCallResult};
use model_context_protocol::{McpServerConfig, McpToolDefinition, ToolContent};
use serde_json::{json, Value};

use fs::Sandbox;

#[derive(Parser)]
#[command(name = "jot-mcp", about = "Jot MCP Server — AI-accessible Markdown notes")]
struct Cli {
    /// 笔记数据目录
    #[arg(long, env = "JOT_DATA_DIR")]
    data_dir: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    if !std::path::Path::new(&cli.data_dir).is_dir() {
        anyhow::bail!("数据目录不存在: {}", cli.data_dir);
    }

    let sandbox = Arc::new(Sandbox::new(&cli.data_dir));

    let config = McpServerConfig::builder()
        .name("jot-mcp")
        .version(env!("CARGO_PKG_VERSION"))
        // P0 — 核心读写
        .with_tool(make_search_notes(sandbox.clone()))
        .with_tool(make_list_directory(sandbox.clone()))
        .with_tool(make_read_note(sandbox.clone()))
        .with_tool(make_append_note(sandbox.clone()))
        .with_tool(make_write_note(sandbox.clone()))
        // P1 — 管理操作
        .with_tool(make_delete_note(sandbox.clone()))
        .with_tool(make_rename_note(sandbox.clone()))
        .with_tool(make_move_note(sandbox.clone()))
        .with_tool(make_create_directory(sandbox.clone()))
        .with_tool(make_list_backlinks(sandbox.clone()))
        .with_tool(make_list_tags(sandbox.clone()))
        .build();

    McpStdioServer::run(config).await?;
    Ok(())
}

// ---- Tool 工厂函数 ----

fn make_search_notes(sb: Arc<Sandbox>) -> FnTool<impl Fn(Value) -> BoxFuture<'static, ToolCallResult> + Send + Sync> {
    let def = McpToolDefinition::new("search_notes")
        .with_description("全文搜索笔记内容。返回匹配的文件名、路径、行号和上下文片段。")
        .with_schema(json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "搜索关键词" },
                "path": { "type": "string", "description": "限定搜索目录（相对于笔记根目录），不传则搜索全部" }
            },
            "required": ["query"]
        }));
    FnTool::new(def, move |args: Value| {
        let sb = sb.clone();
        Box::pin(async move {
            let query = args["query"].as_str().unwrap_or("");
            let path = args["path"].as_str();
            let results = tools::search_content(&sb, query, path)?;
            let text = serde_json::to_string_pretty(&results).unwrap_or_default();
            Ok(vec![ToolContent::text(text)])
        })
    })
}

fn make_list_directory(sb: Arc<Sandbox>) -> FnTool<impl Fn(Value) -> BoxFuture<'static, ToolCallResult> + Send + Sync> {
    let def = McpToolDefinition::new("list_directory")
        .with_description("列出笔记目录树结构。目录优先，只显示 .md 文件。")
        .with_schema(json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "要列出的子目录（相对于笔记根目录），不传则列出根目录" }
            }
        }));
    FnTool::new(def, move |args: Value| {
        let sb = sb.clone();
        Box::pin(async move {
            let p = args["path"].as_str().unwrap_or(".");
            let tree = fs::list_tree(&sb, p)?;
            let text = serde_json::to_string_pretty(&tree).unwrap_or_default();
            Ok(vec![ToolContent::text(text)])
        })
    })
}

fn make_read_note(sb: Arc<Sandbox>) -> FnTool<impl Fn(Value) -> BoxFuture<'static, ToolCallResult> + Send + Sync> {
    let def = McpToolDefinition::new("read_note")
        .with_description("读取指定笔记的完整 Markdown 内容。")
        .with_schema(json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "笔记路径（相对于笔记根目录）" }
            },
            "required": ["path"]
        }));
    FnTool::new(def, move |args: Value| {
        let sb = sb.clone();
        Box::pin(async move {
            let path = args["path"].as_str().unwrap_or("");
            let content = fs::read_file(&sb, path)?;
            let result = json!({ "path": path, "content": content });
            Ok(vec![ToolContent::text(result.to_string())])
        })
    })
}

fn make_append_note(sb: Arc<Sandbox>) -> FnTool<impl Fn(Value) -> BoxFuture<'static, ToolCallResult> + Send + Sync> {
    let def = McpToolDefinition::new("append_note")
        .with_description("在笔记末尾追加内容。适用于日记、待办清单、速记等场景。文件不存在时会自动创建。")
        .with_schema(json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "笔记路径（相对于笔记根目录）" },
                "content": { "type": "string", "description": "要追加的内容" }
            },
            "required": ["path", "content"]
        }));
    FnTool::new(def, move |args: Value| {
        let sb = sb.clone();
        Box::pin(async move {
            let path = args["path"].as_str().unwrap_or("");
            let content = args["content"].as_str().unwrap_or("");
            fs::append_to_file(&sb, path, content)?;
            Ok(vec![ToolContent::text(format!("已追加到: {}", path))])
        })
    })
}

fn make_write_note(sb: Arc<Sandbox>) -> FnTool<impl Fn(Value) -> BoxFuture<'static, ToolCallResult> + Send + Sync> {
    let def = McpToolDefinition::new("write_note")
        .with_description("创建新笔记或覆盖已有笔记的完整内容。使用原子写入确保数据安全。")
        .with_schema(json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "笔记路径（相对于笔记根目录）" },
                "content": { "type": "string", "description": "笔记完整 Markdown 内容" }
            },
            "required": ["path", "content"]
        }));
    FnTool::new(def, move |args: Value| {
        let sb = sb.clone();
        Box::pin(async move {
            let path = args["path"].as_str().unwrap_or("");
            let content = args["content"].as_str().unwrap_or("");
            fs::write_file(&sb, path, content)?;
            Ok(vec![ToolContent::text(format!("已保存: {}", path))])
        })
    })
}

fn make_delete_note(sb: Arc<Sandbox>) -> FnTool<impl Fn(Value) -> BoxFuture<'static, ToolCallResult> + Send + Sync> {
    let def = McpToolDefinition::new("delete_note")
        .with_description("删除指定的笔记文件或目录。此操作不可逆，请谨慎使用。")
        .with_schema(json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "笔记路径（相对于笔记根目录）" }
            },
            "required": ["path"]
        }));
    FnTool::new(def, move |args: Value| {
        let sb = sb.clone();
        Box::pin(async move {
            let path = args["path"].as_str().unwrap_or("");
            fs::delete_path(&sb, path)?;
            Ok(vec![ToolContent::text(format!("已删除: {}", path))])
        })
    })
}

fn make_rename_note(sb: Arc<Sandbox>) -> FnTool<impl Fn(Value) -> BoxFuture<'static, ToolCallResult> + Send + Sync> {
    let def = McpToolDefinition::new("rename_note")
        .with_description("重命名笔记文件或目录。返回新的相对路径。")
        .with_schema(json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "笔记路径（相对于笔记根目录）" },
                "new_name": { "type": "string", "description": "新文件名（不含路径，仅文件名）" }
            },
            "required": ["path", "new_name"]
        }));
    FnTool::new(def, move |args: Value| {
        let sb = sb.clone();
        Box::pin(async move {
            let path = args["path"].as_str().unwrap_or("");
            let new_name = args["new_name"].as_str().unwrap_or("");
            let new_path = fs::rename_path(&sb, path, new_name)?;
            let result = json!({ "ok": true, "oldPath": path, "newPath": new_path });
            Ok(vec![ToolContent::text(result.to_string())])
        })
    })
}

fn make_move_note(sb: Arc<Sandbox>) -> FnTool<impl Fn(Value) -> BoxFuture<'static, ToolCallResult> + Send + Sync> {
    let def = McpToolDefinition::new("move_note")
        .with_description("将笔记或目录移动到目标目录。返回新路径。")
        .with_schema(json!({
            "type": "object",
            "properties": {
                "src": { "type": "string", "description": "源路径（相对于笔记根目录）" },
                "dest_dir": { "type": "string", "description": "目标目录（相对于笔记根目录）" }
            },
            "required": ["src", "dest_dir"]
        }));
    FnTool::new(def, move |args: Value| {
        let sb = sb.clone();
        Box::pin(async move {
            let src = args["src"].as_str().unwrap_or("");
            let dest_dir = args["dest_dir"].as_str().unwrap_or("");
            let new_path = fs::move_path(&sb, src, dest_dir)?;
            let result = json!({ "ok": true, "oldPath": src, "newPath": new_path });
            Ok(vec![ToolContent::text(result.to_string())])
        })
    })
}

fn make_create_directory(sb: Arc<Sandbox>) -> FnTool<impl Fn(Value) -> BoxFuture<'static, ToolCallResult> + Send + Sync> {
    let def = McpToolDefinition::new("create_directory")
        .with_description("在笔记目录中创建新的子目录。")
        .with_schema(json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "目录路径（相对于笔记根目录）" }
            },
            "required": ["path"]
        }));
    FnTool::new(def, move |args: Value| {
        let sb = sb.clone();
        Box::pin(async move {
            let path = args["path"].as_str().unwrap_or("");
            fs::create_dir(&sb, path)?;
            Ok(vec![ToolContent::text(format!("目录已创建: {}", path))])
        })
    })
}

fn make_list_backlinks(sb: Arc<Sandbox>) -> FnTool<impl Fn(Value) -> BoxFuture<'static, ToolCallResult> + Send + Sync> {
    let def = McpToolDefinition::new("list_backlinks")
        .with_description("查询所有链接到指定笔记的反向链接。包括 [[wiki链接]] 和 [文本](路径.md) 两种格式。")
        .with_schema(json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "目标笔记路径（相对于笔记根目录）" }
            },
            "required": ["path"]
        }));
    FnTool::new(def, move |args: Value| {
        let sb = sb.clone();
        Box::pin(async move {
            let path = args["path"].as_str().unwrap_or("");
            let links = tools::get_backlinks(&sb, path)?;
            let text = serde_json::to_string_pretty(&links).unwrap_or_default();
            Ok(vec![ToolContent::text(text)])
        })
    })
}

fn make_list_tags(sb: Arc<Sandbox>) -> FnTool<impl Fn(Value) -> BoxFuture<'static, ToolCallResult> + Send + Sync> {
    let def = McpToolDefinition::new("list_tags")
        .with_description("获取所有笔记的 frontmatter 标签及使用次数和所属文件。")
        .with_schema(json!({
            "type": "object",
            "properties": {}
        }));
    FnTool::new(def, move |_: Value| {
        let sb = sb.clone();
        Box::pin(async move {
            let tags = tools::list_tags(&sb)?;
            let text = serde_json::to_string_pretty(&tags).unwrap_or_default();
            Ok(vec![ToolContent::text(text)])
        })
    })
}
