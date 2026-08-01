use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;

static TEST_MUTEX: Mutex<()> = Mutex::new(());

/// 创建临时笔记目录，填充测试数据，返回目录路径
///
/// tempfile 创建的临时目录名称以 "." 开头（如 /tmp/.tmpXXXXXX），
/// 而 jot-mcp 的 walkdir 遍历会跳过点号开头的隐藏目录（包括所有父级组件），
/// 导致 search_notes/list_backlinks/list_tags 找不到任何文件。
/// 因此直接在 /tmp 下创建非隐藏的测试目录。
fn setup_test_dir() -> PathBuf {
    let dir = PathBuf::from("/tmp").join(format!("jot-mcp-test-{}", std::process::id()));
    // 清理可能残留的旧目录
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();

    // 创建子目录
    fs::create_dir_all(dir.join("projects")).unwrap();

    // 创建测试笔记
    fs::write(
        dir.join("日记.md"),
        "---\ntags: daily\n---\n# 日记\n\n今天天气不错。\n\n## TODO\n- [ ] 完成 MCP 开发\n",
    )
    .unwrap();

    fs::write(
        dir.join("学习笔记.md"),
        "---\ntags: [rust, mcp, learning]\n---\n# Rust MCP 学习\n\nMCP 是 Model Context Protocol 的缩写。\n\n参考 [[日记]] 了解更多。\n\n## 代码示例\n```rust\nfn main() {}\n```\n",
    )
    .unwrap();

    fs::write(
        dir.join("projects").join("设计文档.md"),
        "---\ntags: design\n---\n# 设计文档\n\n详见 [学习笔记](../学习笔记.md)。\n",
    )
    .unwrap();

    dir
}

/// 向 jot-mcp 发送 JSON-RPC 请求并返回响应。
/// 写入请求到 stdin，从 stdout 读取单行 JSON-RPC 响应。
fn send_request(binary: &str, data_dir: &str, request: &str) -> String {
    let mut child = Command::new(binary)
        .arg("--data-dir")
        .arg(data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("启动 jot-mcp 失败");

    // 写入请求到 stdin
    {
        let stdin = child.stdin.as_mut().unwrap();
        stdin.write_all(request.as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();
    }

    // 从 stdout 读取响应（放在 block scope 内以释放 borrow，便于后续 kill）
    let response = {
        let stdout = child.stdout.as_mut().unwrap();
        let reader = BufReader::new(stdout);
        let mut response = String::new();
        for line in reader.lines() {
            if let Ok(l) = line {
                response.push_str(&l);
                // JSON-RPC 响应以 "id":N 为标志，单行读取到此即完成
                if l.contains("\"id\"") {
                    break;
                }
            }
        }
        response
    };

    // 给进程一点时间处理，然后 kill
    std::thread::sleep(std::time::Duration::from_millis(100));
    let _ = child.kill();

    response
}

/// 获取 jot-mcp 二进制路径
fn binary_path() -> String {
    // cargo test 环境下 CARGO_MANIFEST_DIR = src-mcp/
    // 二进制在 target/<profile>/jot-mcp，Windows 上带 .exe 后缀
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let bin_name = format!("jot-mcp{}", std::env::consts::EXE_SUFFIX);
    let target_dir = manifest_dir
        .parent()
        .unwrap()
        .join("target")
        .join("debug")
        .join(&bin_name);
    if target_dir.exists() {
        return target_dir.to_string_lossy().to_string();
    }
    // 也尝试 release 目录
    let release = manifest_dir
        .parent()
        .unwrap()
        .join("target")
        .join("release")
        .join(&bin_name);
    if release.exists() {
        return release.to_string_lossy().to_string();
    }
    panic!("请先执行 cargo build -p jot-mcp");
}

#[test]
fn tools_list_returns_all_tools() {
    // 容忍 Mutex 中毒：单个测试失败不应因 PoisonError 掩盖其余测试的真实结果
    let _lock = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let dir = setup_test_dir();
    let bin = binary_path();

    let request = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"#;
    let response = send_request(&bin, dir.to_str().unwrap(), request);

    assert!(
        response.contains("search_notes"),
        "应在 tools 列表中包含 search_notes"
    );
    assert!(
        response.contains("append_note"),
        "应在 tools 列表中包含 append_note"
    );
    assert!(
        response.contains("write_note"),
        "应在 tools 列表中包含 write_note"
    );
    assert!(
        response.contains("list_backlinks"),
        "应在 tools 列表中包含 list_backlinks"
    );
    assert!(
        response.contains("list_tags"),
        "应在 tools 列表中包含 list_tags"
    );
}

#[test]
fn search_notes_finds_content() {
    // 容忍 Mutex 中毒：单个测试失败不应因 PoisonError 掩盖其余测试的真实结果
    let _lock = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let dir = setup_test_dir();
    let bin = binary_path();

    let request = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_notes","arguments":{"query":"MCP"}}}"#;
    let response = send_request(&bin, dir.to_str().unwrap(), request);

    assert!(
        response.contains("学习笔记"),
        "搜索 'MCP' 应找到学习笔记"
    );
    assert!(
        response.contains("Model Context Protocol"),
        "搜索结果应包含匹配内容"
    );
}

#[test]
fn read_note_returns_content() {
    // 容忍 Mutex 中毒：单个测试失败不应因 PoisonError 掩盖其余测试的真实结果
    let _lock = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let dir = setup_test_dir();
    let bin = binary_path();

    let request = r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_note","arguments":{"path":"日记.md"}}}"#;
    let response = send_request(&bin, dir.to_str().unwrap(), request);

    assert!(
        response.contains("今天天气不错"),
        "read_note 应返回文件内容"
    );
}

#[test]
fn append_note_adds_content() {
    // 容忍 Mutex 中毒：单个测试失败不应因 PoisonError 掩盖其余测试的真实结果
    let _lock = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let dir = setup_test_dir();
    let bin = binary_path();

    let request = r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"append_note","arguments":{"path":"日记.md","content":"追加的测试行"}}}"#;
    let response = send_request(&bin, dir.to_str().unwrap(), request);

    assert!(response.contains("已追加"), "append_note 应成功");

    // 验证文件内容
    let content = fs::read_to_string(dir.join("日记.md")).unwrap();
    assert!(
        content.contains("追加的测试行"),
        "文件中应包含追加的内容"
    );
    assert!(content.contains("今天天气不错"), "原有内容不应丢失");
}

#[test]
fn write_note_creates_new_file() {
    // 容忍 Mutex 中毒：单个测试失败不应因 PoisonError 掩盖其余测试的真实结果
    let _lock = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let dir = setup_test_dir();
    let bin = binary_path();

    // 使用 r## 避免内容中的 "# 提前终结 raw string
    let request = r##"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"write_note","arguments":{"path":"新笔记.md","content":"# 新笔记\n\n全新的内容。"}}}"##;
    let response = send_request(&bin, dir.to_str().unwrap(), request);

    assert!(response.contains("已保存"), "write_note 应成功");

    let content = fs::read_to_string(dir.join("新笔记.md")).unwrap();
    assert_eq!(content, "# 新笔记\n\n全新的内容。");
}

#[test]
fn list_backlinks_finds_references() {
    // 容忍 Mutex 中毒：单个测试失败不应因 PoisonError 掩盖其余测试的真实结果
    let _lock = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let dir = setup_test_dir();
    let bin = binary_path();

    let request = r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"list_backlinks","arguments":{"path":"日记.md"}}}"#;
    let response = send_request(&bin, dir.to_str().unwrap(), request);

    // 学习笔记.md 中有 [[日记]] 链接
    assert!(
        response.contains("学习笔记"),
        "学习笔记应反向链接到日记"
    );
}

#[test]
fn list_tags_aggregates_correctly() {
    // 容忍 Mutex 中毒：单个测试失败不应因 PoisonError 掩盖其余测试的真实结果
    let _lock = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let dir = setup_test_dir();
    let bin = binary_path();

    let request = r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"list_tags","arguments":{}}}"#;
    let response = send_request(&bin, dir.to_str().unwrap(), request);

    assert!(response.contains("daily"), "应包含 daily 标签");
    assert!(response.contains("rust"), "应包含 rust 标签");
    assert!(response.contains("mcp"), "应包含 mcp 标签");
}

#[test]
fn sandbox_rejects_path_traversal() {
    // 容忍 Mutex 中毒：单个测试失败不应因 PoisonError 掩盖其余测试的真实结果
    let _lock = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let dir = setup_test_dir();
    let bin = binary_path();

    let request = r#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"read_note","arguments":{"path":"../etc/passwd"}}}"#;
    let response = send_request(&bin, dir.to_str().unwrap(), request);

    // MCP 工具错误返回 result 字段但 isError: true（非 JSON-RPC error 对象）
    assert!(
        response.contains("\"isError\":true"),
        "路径穿越应返回 isError: true"
    );
    assert!(
        response.contains(".."),
        "应返回包含 '..' 的错误信息"
    );
}
