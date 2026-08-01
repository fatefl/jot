use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// 路径沙箱 —— 所有文件操作必须通过它解析路径
pub struct Sandbox {
    pub data_dir: PathBuf,
}

/// 目录树节点
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<TreeNode>,
}

impl Sandbox {
    pub fn new(data_dir: &str) -> Self {
        // 规范化根目录：macOS 上 /tmp、/var 是指向 /private/... 的符号链接，
        // 若不规范化，resolve() 中 canonicalize 后的路径与未规范化的根目录比较会误判越界
        let canonical = PathBuf::from(data_dir)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(data_dir));
        Self {
            data_dir: canonical,
        }
    }

    /// 将相对路径解析为沙箱内绝对路径。
    /// 拒绝 `..` 路径穿越，拒绝符号链接逃逸。
    pub fn resolve(&self, relative: &str) -> Result<PathBuf, String> {
        // 1. 拒绝包含 .. 的路径
        if relative.contains("..") {
            return Err(format!("路径不允许包含 '..': {}", relative));
        }

        // 2. 拼接绝对路径
        let resolved = self.data_dir.join(relative);

        // 3. 规范化后验证仍在 data_dir 内
        let canonical = match resolved.canonicalize() {
            Ok(p) => p,
            // 目标文件尚不存在（如 write_note 新建）——规范化存在的父目录再拼接文件名，
            // 这样符号链接的目录分量仍会被解析，越界检查不会失效
            Err(_) => {
                let parent = resolved.parent();
                let file_name = resolved.file_name();
                match (parent, file_name) {
                    (Some(p), Some(n)) => p
                        .canonicalize()
                        .unwrap_or_else(|_| p.to_path_buf())
                        .join(n),
                    _ => resolved.clone(),
                }
            }
        };
        if !canonical.starts_with(&self.data_dir) {
            return Err(format!("路径越界: {}", relative));
        }

        Ok(canonical)
    }
}

/// 读取文件完整内容
pub fn read_file(sandbox: &Sandbox, path: &str) -> Result<String, String> {
    let full = sandbox.resolve(path)?;
    if full.is_dir() {
        return Err(format!("'{}' 是一个目录，不是文件", path));
    }
    fs::read_to_string(&full).map_err(|e| format!("读取失败 '{}': {}", path, e))
}

/// 原子写入文件（先写临时文件再 rename）
pub fn write_file(sandbox: &Sandbox, path: &str, content: &str) -> Result<(), String> {
    let full = sandbox.resolve(path)?;
    if full.is_dir() {
        return Err(format!("'{}' 是一个目录", path));
    }

    // 确保父目录存在
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录失败: {}", e))?;
    }

    // 原子写入：临时文件 + rename
    let tmp = full.with_extension("tmp");
    let mut f = fs::File::create(&tmp)
        .map_err(|e| format!("写入失败 '{}': {}", path, e))?;
    f.write_all(content.as_bytes())
        .map_err(|e| format!("写入失败 '{}': {}", path, e))?;
    f.flush()
        .map_err(|e| format!("写入失败 '{}': {}", path, e))?;
    fs::rename(&tmp, &full)
        .map_err(|e| format!("写入失败 '{}': {}", path, e))?;
    Ok(())
}

/// 在文件末尾追加内容。文件不存在则创建。
pub fn append_to_file(sandbox: &Sandbox, path: &str, content: &str) -> Result<(), String> {
    let full = sandbox.resolve(path)?;

    // 确保父目录存在
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录失败: {}", e))?;
    }

    // 原子追加：读原文件 → 拼接 → 写入临时文件 → rename
    let existing = if full.exists() {
        fs::read_to_string(&full).unwrap_or_default()
    } else {
        String::new()
    };

    let (separator, new_content) = if existing.is_empty() {
        ("", content.to_string())
    } else if existing.ends_with('\n') {
        ("", format!("{}\n", content))
    } else {
        ("\n", format!("\n{}\n", content))
    };

    let tmp = full.with_extension("tmp");
    let mut f = fs::File::create(&tmp)
        .map_err(|e| format!("写入失败 '{}': {}", path, e))?;
    write!(f, "{}{}{}", existing, separator, new_content)
        .map_err(|e| format!("写入失败 '{}': {}", path, e))?;
    f.flush()
        .map_err(|e| format!("写入失败 '{}': {}", path, e))?;
    fs::rename(&tmp, &full)
        .map_err(|e| format!("写入失败 '{}': {}", path, e))?;
    Ok(())
}

/// 删除文件
pub fn delete_path(sandbox: &Sandbox, path: &str) -> Result<(), String> {
    let full = sandbox.resolve(path)?;
    if full.is_dir() {
        fs::remove_dir_all(&full).map_err(|e| format!("删除失败 '{}': {}", path, e))
    } else {
        fs::remove_file(&full).map_err(|e| format!("删除失败 '{}': {}", path, e))
    }
}

/// 重命名（同一目录内）
pub fn rename_path(sandbox: &Sandbox, path: &str, new_name: &str) -> Result<String, String> {
    let full = sandbox.resolve(path)?;
    let parent = full.parent().unwrap_or(Path::new("."));
    let new_path = parent.join(new_name);

    // 验证新路径也在沙箱内
    let new_canonical = new_path.canonicalize().unwrap_or(new_path.clone());
    if !new_canonical.starts_with(&sandbox.data_dir) {
        return Err("重命名目标越界".to_string());
    }

    fs::rename(&full, &new_path)
        .map_err(|e| format!("重命名失败 '{}': {}", path, e))?;

    // 返回新的相对路径
    new_path
        .strip_prefix(&sandbox.data_dir)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("路径解析失败: {}", e))
}

/// 移动文件到目标目录
pub fn move_path(sandbox: &Sandbox, src: &str, dest_dir: &str) -> Result<String, String> {
    let src_full = sandbox.resolve(src)?;
    let dest_full = sandbox.resolve(dest_dir)?;

    if !dest_full.is_dir() {
        return Err(format!("目标不是目录: {}", dest_dir));
    }

    let name = src_full.file_name()
        .ok_or_else(|| format!("无效的源路径: {}", src))?;
    let new_path = dest_full.join(name);

    // 原子移动：先复制再删除源（跨文件系统兼容）
    if src_full.is_dir() {
        copy_dir_recursive(&src_full, &new_path)
            .map_err(|e| format!("移动失败: {}", e))?;
        fs::remove_dir_all(&src_full)
            .map_err(|e| format!("移动后清理失败: {}", e))?;
    } else {
        fs::copy(&src_full, &new_path)
            .map_err(|e| format!("移动失败: {}", e))?;
        fs::remove_file(&src_full)
            .map_err(|e| format!("移动后清理失败: {}", e))?;
    }

    new_path
        .strip_prefix(&sandbox.data_dir)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("路径解析失败: {}", e))
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dest_child = dest.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_child)?;
        } else {
            fs::copy(entry.path(), &dest_child)?;
        }
    }
    Ok(())
}

/// 创建目录
pub fn create_dir(sandbox: &Sandbox, path: &str) -> Result<(), String> {
    let full = sandbox.resolve(path)?;
    fs::create_dir_all(&full)
        .map_err(|e| format!("创建目录失败 '{}': {}", path, e))
}

/// 递归列出目录树（仅 .md 文件 + 目录，隐藏文件和 .assets 除外）
pub fn list_tree(sandbox: &Sandbox, path: &str) -> Result<TreeNode, String> {
    let full = sandbox.resolve(path)?;

    let name = full
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());

    let relative = full
        .strip_prefix(&sandbox.data_dir)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string());

    if full.is_dir() {
        let mut children: Vec<TreeNode> = Vec::new();
        if let Ok(entries) = fs::read_dir(&full) {
            let mut dirs = Vec::new();
            let mut files = Vec::new();

            for entry in entries.flatten() {
                let file_name = entry.file_name().to_string_lossy().to_string();
                // 跳过隐藏文件和 .assets
                if file_name.starts_with('.') {
                    continue;
                }
                let child_path = relative.clone() + "/" + &file_name;
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    dirs.push(child_path);
                } else if file_name.ends_with(".md") {
                    files.push(child_path);
                }
            }

            // 目录优先
            dirs.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
            files.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));

            for child_path in dirs {
                if let Ok(node) = list_tree(sandbox, &child_path) {
                    children.push(node);
                }
            }
            for child_path in files {
                if let Ok(node) = list_tree(sandbox, &child_path) {
                    children.push(node);
                }
            }
        }

        Ok(TreeNode {
            name,
            path: relative,
            is_dir: true,
            children,
        })
    } else {
        Ok(TreeNode {
            name,
            path: relative,
            is_dir: false,
            children: vec![],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_sandbox() -> (Sandbox, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let sandbox = Sandbox::new(tmp.path().to_str().unwrap());
        (sandbox, tmp)
    }

    #[test]
    fn resolve_normal_path() {
        let (sb, _tmp) = setup_sandbox();
        let result = sb.resolve("test.md");
        assert!(result.is_ok());
    }

    #[test]
    fn reject_dotdot() {
        let (sb, _tmp) = setup_sandbox();
        let result = sb.resolve("../etc/passwd");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains(".."));
    }

    #[test]
    fn reject_symlink_escape() {
        let (sb, tmp) = setup_sandbox();
        // 在 data_dir 内创建指向外部的符号链接
        let outside = tmp.path().parent().unwrap().join("outside.txt");
        fs::write(&outside, b"secret").unwrap();
        std::os::unix::fs::symlink(&outside, tmp.path().join("link")).unwrap();
        let result = sb.resolve("link");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("越界"));
    }
}
