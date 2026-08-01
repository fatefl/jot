use crate::fs::Sandbox;
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::fs as std_fs;

/// 搜索结果
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub name: String,
    pub path: String,
    pub line: usize,
    pub context: String,
}

/// 反向链接信息
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkInfo {
    pub name: String,
    pub path: String,
    pub line: usize,
    pub context: String,
}

/// 标签信息
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub tag: String,
    pub count: usize,
    pub files: Vec<String>,
}

/// 在笔记目录中全文搜索关键词，返回匹配的片段
pub fn search_content(
    sandbox: &Sandbox,
    query: &str,
    sub_dir: Option<&str>,
) -> Result<Vec<SearchMatch>, String> {
    let search_root = match sub_dir {
        Some(d) => sandbox.resolve(d)?,
        None => sandbox.data_dir.clone(),
    };

    let query_lower = query.to_lowercase();
    let mut results: Vec<SearchMatch> = Vec::new();

    for entry in walkdir::WalkDir::new(&search_root)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file()
            || path.extension().and_then(|e| e.to_str()) != Some("md")
        {
            continue;
        }

        // 跳过隐藏目录中的文件
        if path.components().any(|c| {
            c.as_os_str()
                .to_str()
                .map(|s| s.starts_with('.') && s != ".")
                .unwrap_or(false)
        }) {
            continue;
        }

        let content = match std_fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let rel_path = path
            .strip_prefix(&sandbox.data_dir)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        for (i, line) in content.lines().enumerate() {
            if line.to_lowercase().contains(&query_lower) {
                let start = if i >= 3 { i - 3 } else { 0 };
                let end = (i + 4).min(content.lines().count());
                let context = content
                    .lines()
                    .skip(start)
                    .take(end - start)
                    .collect::<Vec<&str>>()
                    .join("\n");

                results.push(SearchMatch {
                    name: name.clone(),
                    path: rel_path.clone(),
                    line: i + 1, // 1-indexed
                    context,
                });
            }
        }
    }

    // 按路径 + 行号排序
    results.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));

    Ok(results)
}

/// 扫描所有 .md 文件，找出链接到 target_file 的文件
pub fn get_backlinks(
    sandbox: &Sandbox,
    target_file: &str,
) -> Result<Vec<BacklinkInfo>, String> {
    // 规范化 target：去掉 .md 后缀、转为相对路径的各种形式
    let target_stem = target_file
        .trim_end_matches(".md")
        .trim_start_matches('/');

    let mut results: Vec<BacklinkInfo> = Vec::new();

    // 匹配 [[链接]] 和 [文本](路径.md) 两种格式
    let wiki_link = Regex::new(r"\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]").unwrap();
    let md_link = Regex::new(r"\[([^\]]*)\]\(([^)]+\.md)\)").unwrap();

    for entry in walkdir::WalkDir::new(&sandbox.data_dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file()
            || path.extension().and_then(|e| e.to_str()) != Some("md")
        {
            continue;
        }

        // 跳过隐藏目录
        if path.components().any(|c| {
            c.as_os_str()
                .to_str()
                .map(|s| s.starts_with('.') && s != ".")
                .unwrap_or(false)
        }) {
            continue;
        }

        let content = match std_fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let rel_path = path
            .strip_prefix(&sandbox.data_dir)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        // 检查 wiki 链接 [[target]]
        for cap in wiki_link.captures_iter(&content) {
            let linked = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            // 比较链接目标（去除 .md 后缀）
            let linked_stem = linked.trim_end_matches(".md");

            if linked_stem == target_stem
                || linked_stem.ends_with(&format!("/{}", target_stem))
            {
                let line_num = content[..cap.get(0).unwrap().start()]
                    .lines()
                    .count()
                    + 1;
                // 提取上下文（链接所在行 +- 1 行）
                let lines: Vec<&str> = content.lines().collect();
                let start = if line_num >= 2 { line_num - 2 } else { 0 };
                let end = (line_num + 1).min(lines.len());
                let context = lines[start..end].join("\n");

                results.push(BacklinkInfo {
                    name: name.clone(),
                    path: rel_path.clone(),
                    line: line_num,
                    context,
                });
            }
        }

        // 检查 markdown 链接 [text](path.md)
        for cap in md_link.captures_iter(&content) {
            let linked = cap.get(2).map(|m| m.as_str()).unwrap_or("");
            let linked_stem = linked.trim_end_matches(".md");

            if linked_stem == target_stem
                || linked_stem.ends_with(&format!("/{}", target_stem))
            {
                let line_num = content[..cap.get(0).unwrap().start()]
                    .lines()
                    .count()
                    + 1;
                let lines: Vec<&str> = content.lines().collect();
                let start = if line_num >= 2 { line_num - 2 } else { 0 };
                let end = (line_num + 1).min(lines.len());
                let context = lines[start..end].join("\n");

                results.push(BacklinkInfo {
                    name: name.clone(),
                    path: rel_path.clone(),
                    line: line_num,
                    context,
                });
            }
        }
    }

    // 去重（同一文件可能同时有 wiki 和 md 链接指向同一目标）
    results.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    results.dedup_by(|a, b| a.path == b.path && a.line == b.line);

    Ok(results)
}

/// 从所有 .md 文件的 YAML frontmatter 中提取 tags 字段，聚合统计
pub fn list_tags(sandbox: &Sandbox) -> Result<Vec<TagInfo>, String> {
    let mut tag_map: HashMap<String, Vec<String>> = HashMap::new();

    for entry in walkdir::WalkDir::new(&sandbox.data_dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file()
            || path.extension().and_then(|e| e.to_str()) != Some("md")
        {
            continue;
        }

        if path.components().any(|c| {
            c.as_os_str()
                .to_str()
                .map(|s| s.starts_with('.') && s != ".")
                .unwrap_or(false)
        }) {
            continue;
        }

        let content = match std_fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let rel_path = path
            .strip_prefix(&sandbox.data_dir)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let tags = extract_frontmatter_tags(&content);

        for tag in tags {
            tag_map.entry(tag).or_default().push(rel_path.clone());
        }
    }

    let mut results: Vec<TagInfo> = tag_map
        .into_iter()
        .map(|(tag, files)| TagInfo {
            count: files.len(),
            tag,
            files,
        })
        .collect();

    results.sort_by(|a, b| b.count.cmp(&a.count).then(a.tag.cmp(&b.tag)));
    Ok(results)
}

/// 从 Markdown 文本中提取 YAML frontmatter 的 tags 字段
fn extract_frontmatter_tags(content: &str) -> Vec<String> {
    // 检查是否以 --- 开头
    if !content.starts_with("---") {
        return vec![];
    }

    // 找到第二个 ---
    let rest = &content[3..];
    let end = match rest.find("\n---") {
        Some(i) => i,
        None => return vec![],
    };

    let frontmatter = &rest[..end];

    // 查找 tags: 行
    let mut tags = Vec::new();
    let tag_key = Regex::new(r"^tags:\s*(.*)").unwrap();
    let list_item = Regex::new(r"^\s*-\s+(.+)").unwrap();

    for line in frontmatter.lines() {
        // 行内数组: tags: [a, b, c]
        if let Some(cap) = tag_key.captures(line) {
            let value = cap.get(1).map(|m| m.as_str().trim()).unwrap_or("");
            if value.starts_with('[') {
                // 行内数组格式
                let inner = value.trim_start_matches('[').trim_end_matches(']');
                for tag in inner.split(',') {
                    let t = tag.trim().trim_matches('"').trim_matches('\'');
                    if !t.is_empty() {
                        tags.push(t.to_string());
                    }
                }
            } else if !value.is_empty() {
                // 单个值: tags: foo
                tags.push(value.to_string());
            }
            // YAML 列表格式: tags:\n  - a\n  - b
            // 将在后续行处理
        }

        // YAML 列表项: - tag
        if let Some(cap) = list_item.captures(line) {
            let tag = cap.get(1).map(|m| m.as_str().trim()).unwrap_or("");
            if !tag.is_empty() {
                tags.push(tag.to_string());
            }
        }
    }

    tags
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_tags_inline_array() {
        let content = "---\ntags: [rust, mcp, note]\n---\n# Title";
        let tags = extract_frontmatter_tags(content);
        assert_eq!(tags, vec!["rust", "mcp", "note"]);
    }

    #[test]
    fn extract_tags_yaml_list() {
        let content = "---\ntags:\n  - rust\n  - mcp\n---\n# Title";
        let tags = extract_frontmatter_tags(content);
        assert_eq!(tags, vec!["rust", "mcp"]);
    }

    #[test]
    fn extract_tags_single_value() {
        let content = "---\ntags: daily\n---\n# Title";
        let tags = extract_frontmatter_tags(content);
        assert_eq!(tags, vec!["daily"]);
    }

    #[test]
    fn no_frontmatter() {
        let content = "# No frontmatter\njust content";
        let tags = extract_frontmatter_tags(content);
        assert!(tags.is_empty());
    }
}
