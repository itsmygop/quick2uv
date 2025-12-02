const fs = require("fs");
const path = require("path");

// Token 预算配置（大约 1 token ≈ 4 字符）
const TOKEN_BUDGET = {
  total: 6000,        // 总预算（字符数）
  readme: 2500,       // README 预算
  configFiles: 2000,  // 配置文件总预算
  pythonFiles: 1500,  // Python 文件总预算
};

/**
 * 智能截取 README，优先保留关键章节
 * @param {string} content - README 原始内容
 * @param {number} maxLen - 最大字符数
 * @returns {string}
 */
function smartTruncateReadme(content, maxLen) {
  if (!content || content.length <= maxLen) return content;

  // 关键章节的正则匹配（按优先级排序）
  const prioritySections = [
    /#{1,3}\s*(usage|使用|用法|cli|command|命令)[^\n]*\n[\s\S]*?(?=\n#{1,3}\s|\n*$)/gi,
    /#{1,3}\s*(install|安装|quick\s*start|快速开始)[^\n]*\n[\s\S]*?(?=\n#{1,3}\s|\n*$)/gi,
    /#{1,3}\s*(example|示例|demo)[^\n]*\n[\s\S]*?(?=\n#{1,3}\s|\n*$)/gi,
    /```[\s\S]*?```/g,  // 代码块通常包含使用示例
  ];

  let extracted = [];
  let remainingBudget = maxLen;

  // 先提取标题和简介（前 500 字符）
  const intro = content.slice(0, 500);
  extracted.push(intro);
  remainingBudget -= intro.length;

  // 按优先级提取关键章节
  for (const regex of prioritySections) {
    if (remainingBudget <= 0) break;

    const matches = content.match(regex) || [];
    for (const match of matches) {
      if (remainingBudget <= 0) break;
      // 避免重复（已在 intro 中）
      if (intro.includes(match)) continue;

      const truncated = match.slice(0, remainingBudget);
      if (truncated.length > 100) {  // 只保留有意义的片段
        extracted.push(truncated);
        remainingBudget -= truncated.length;
      }
    }
  }

  return extracted.join("\n\n...\n\n");
}

/**
 * 智能截取 Python 文件，优先保留入口点相关代码
 * @param {string} content - Python 文件内容
 * @param {number} maxLen - 最大字符数
 * @returns {string}
 */
function smartTruncatePython(content, maxLen) {
  if (!content || content.length <= maxLen) return content;

  const lines = content.split("\n");
  let result = [];
  let currentLen = 0;

  // 1. 先保留 import 语句（通常在开头）
  const importLines = [];
  let importEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(import |from .+ import )/.test(line)) {
      importLines.push(line);
      importEnd = i;
    } else if (importLines.length > 0 && line.trim() === "") {
      continue;  // 跳过 import 之间的空行
    } else if (importLines.length > 0) {
      break;  // import 区域结束
    }
  }

  // 2. 查找入口点相关代码（通常在文件末尾）
  const entryPatterns = [
    /if\s+__name__\s*==\s*["']__main__["']/,
    /def\s+(main|run|cli|app|start)\s*\(/,
    /\.add_command\(/,
    /@click\.(command|group)/,
    /argparse\.ArgumentParser/,
  ];

  // 从末尾向前查找入口点
  let entryStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const pattern of entryPatterns) {
      if (pattern.test(lines[i])) {
        entryStart = i;
        break;
      }
    }
    if (entryStart !== -1) break;
  }

  // 3. 组装结果
  const halfBudget = Math.floor(maxLen / 2);

  // 添加 import 部分
  const importSection = importLines.join("\n");
  if (importSection.length < halfBudget) {
    result.push(importSection);
    currentLen += importSection.length;
  }

  // 添加入口点部分（从入口点往前多取一些上下文）
  if (entryStart !== -1) {
    const contextStart = Math.max(entryStart - 20, importEnd + 1);  // 入口点前 20 行作为上下文
    const entrySection = lines.slice(contextStart).join("\n");

    if (currentLen + entrySection.length <= maxLen) {
      if (contextStart > importEnd + 1) {
        result.push("\n# ... (中间代码省略) ...\n");
      }
      result.push(entrySection);
    } else {
      // 预算不够，截取末尾部分
      const remaining = maxLen - currentLen - 50;
      if (remaining > 0) {
        result.push("\n# ... (中间代码省略) ...\n");
        result.push(entrySection.slice(-remaining));
      }
    }
  } else {
    // 没找到入口点，保留头尾
    const remaining = maxLen - currentLen;
    const middleContent = lines.slice(importEnd + 1).join("\n");
    if (middleContent.length <= remaining) {
      result.push(middleContent);
    } else {
      result.push(middleContent.slice(0, remaining / 2));
      result.push("\n# ... (中间代码省略) ...\n");
      result.push(middleContent.slice(-remaining / 2));
    }
  }

  return result.join("\n");
}

/**
 * 按预算分配截取多个文件
 * @param {Object} fileContents - 文件名 -> 内容的映射
 * @param {number} totalBudget - 总字符预算
 * @param {Function} truncateFn - 截取函数
 * @returns {Object}
 */
function truncateFilesByBudget(fileContents, totalBudget, truncateFn) {
  const files = Object.entries(fileContents);
  if (files.length === 0) return {};

  // 按文件大小排序，优先处理小文件（完整保留）
  files.sort((a, b) => a[1].length - b[1].length);

  const result = {};
  let remaining = totalBudget;
  const perFileBudget = Math.floor(totalBudget / files.length);

  for (const [fileName, content] of files) {
    if (remaining <= 0) break;

    const budget = Math.min(remaining, Math.max(perFileBudget, 500));
    result[fileName] = truncateFn ? truncateFn(content, budget) : content.slice(0, budget);
    remaining -= result[fileName].length;
  }

  return result;
}

// Load template
const pyprojectTemplate = fs.readFileSync(
  path.join(process.cwd(), "assets/pyproject.toml"),
  "utf8"
);

/**
 * 使用 AI 生成 pyproject.toml 内容
 * @param {object} options
 * @param {object} options.octokit - GitHub Octokit 实例
 * @param {object} options.repo - 仓库信息
 * @param {string} [options.apiKey] - DeepSeek API Key
 * @param {object} [options.log] - 日志对象 (可选)
 * @returns {Promise<string>}
 */
async function createPCbyAI({ octokit, repo, apiKey, log }) {
  const logger = log || console;
  const owner = repo.owner.login;
  const repoName = repo.name;

  // 1. 获取仓库文件列表，寻找依赖相关文件
  const filesToCheck = [
    "requirements.txt",
    "setup.py",
    "setup.cfg",
    "Pipfile",
    "pyproject.toml",
  ];
  const fileContents = {};

  for (const fileName of filesToCheck) {
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo: repoName,
        path: fileName,
      });
      if (data.content) {
        fileContents[fileName] = Buffer.from(data.content, "base64").toString(
          "utf8"
        );
      }
    } catch (e) {
      // 文件不存在，跳过
    }
  }

  // 1.5 读取 README 文件（优先用于推断入口点）
  let readmeContent = null;
  const readmeFiles = ["README.md", "readme.md", "README.rst", "README.txt", "README"];
  for (const readmeName of readmeFiles) {
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo: repoName,
        path: readmeName,
      });
      if (data.content) {
        readmeContent = Buffer.from(data.content, "base64").toString("utf8");
        break; // 找到一个就停止
      }
    } catch (e) {
      // 继续尝试下一个
    }
  }

  // 1.6 获取最新 release 版本号
  let latestVersion = "0.0.1";
  try {
    const { data: release } = await octokit.repos.getLatestRelease({
      owner,
      repo: repoName,
    });
    // 去掉 tag 前缀 v（如 v1.0.0 -> 1.0.0）
    latestVersion = release.tag_name.replace(/^v/, "");
  } catch (e) {
    // 没有 release，使用默认版本
  }

  // 2. 获取仓库根目录文件列表
  let pythonFiles = [];
  let allRootFiles = []; // 所有根目录文件（用于 AI 判断 include）
  const pythonFileContents = {};
  try {
    const { data: contents } = await octokit.repos.getContent({
      owner,
      repo: repoName,
      path: "",
    });

    // 保存所有文件和目录名
    allRootFiles = contents.map((f) => (f.type === "dir" ? `${f.name}/` : f.name));

    pythonFiles = contents
      .filter((f) => f.type === "file" && f.name.endsWith(".py"))
      .map((f) => f.name);

    // 读取 Python 文件内容（用于推断入口点）
    for (const pyFile of pythonFiles.slice(0, 5)) {
      // 最多读取 5 个文件
      try {
        const { data } = await octokit.repos.getContent({
          owner,
          repo: repoName,
          path: pyFile,
        });
        if (data.content) {
          pythonFileContents[pyFile] = Buffer.from(
            data.content,
            "base64"
          ).toString("utf8");
        }
      } catch (e) {
        // 忽略
      }
    }
  } catch (e) {
    // 忽略错误
  }

  // 3. 构建 prompt
  const baseContent = createPC(repo, latestVersion);
  const prompt = buildAIPrompt(
    repo,
    fileContents,
    pythonFiles,
    pythonFileContents,
    readmeContent,
    allRootFiles,
    latestVersion,
    baseContent
  );

  // 调试输出
  logger.info?.("=== AI Prompt ===");
  logger.info?.(prompt);
  logger.info?.("=================");

  // 4. 调用 DeepSeek API
  const deepseekKey = apiKey || process.env.DEEPSEEK_API_KEY;
  if (!deepseekKey) {
    throw new Error("DEEPSEEK_API_KEY is not set");
  }

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${deepseekKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content:
            "你是一个 Python 打包专家。用户会给你一个 Python 项目的信息，你需要生成一个完整的 pyproject.toml 文件。只输出 pyproject.toml 的内容，不要有任何其他文字或 markdown 代码块标记。",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  let content = data.choices[0].message.content.trim();

  // 清理可能的 markdown 代码块标记
  content = content.replace(/^```toml?\n?/i, "").replace(/\n?```$/i, "");

  // 调试输出
  logger.info?.("=== AI Response ===");
  logger.info?.(content);
  logger.info?.("===================");

  // 5. 检测是否需要修改入口文件
  let entryFile = null;
  // const needsEntryFix = content.includes("# TODO: 请确认") && content.includes("中有 main() 函数");
  const needsEntryFix = false;

  if (needsEntryFix && Object.keys(pythonFileContents).length > 0) {
    // 从 pyproject.toml 中提取入口文件名
    const scriptMatch = content.match(/\[project\.scripts\][\s\S]*?=\s*"([^:]+):(\w+)"/);
    if (scriptMatch) {
      const moduleName = scriptMatch[1]; // e.g., "main"
      const funcName = scriptMatch[2]; // e.g., "main"
      const entryFileName = `${moduleName}.py`;

      if (pythonFileContents[entryFileName]) {
        // 发送第二次 AI 请求，生成包装后的入口文件
        logger.info?.("=== Generating entry file wrapper ===");

        const entryPrompt = buildEntryFilePrompt(
          entryFileName,
          pythonFileContents[entryFileName],
          funcName
        );

        const entryResponse = await fetch(
          "https://api.deepseek.com/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${deepseekKey}`,
            },
            body: JSON.stringify({
              model: "deepseek-chat",
              messages: [
                {
                  role: "system",
                  content:
                    "你是一个 Python 专家。用户会给你一个 Python 文件，你需要为它添加一个入口函数包装。只输出修改后的完整 Python 代码，不要有任何其他文字或 markdown 代码块标记。",
                },
                {
                  role: "user",
                  content: entryPrompt,
                },
              ],
              temperature: 0.3,
              max_tokens: 4000,
            }),
          }
        );

        if (entryResponse.ok) {
          const entryData = await entryResponse.json();
          let entryContent = entryData.choices[0].message.content.trim();
          entryContent = entryContent
            .replace(/^```python?\n?/i, "")
            .replace(/\n?```$/i, "");

          entryFile = {
            path: entryFileName,
            content: entryContent,
          };

          // 移除 pyproject.toml 中的 TODO 注释（因为我们已经修复了入口文件）
          content = content.replace(
            /# TODO: 请确认.*中有 main\(\) 函数.*\n/,
            ""
          );

          logger.info?.("=== Entry file generated ===");
          logger.info?.(entryContent);
        }
      }
    }
  }

  return {
    pyproject: content,
    entryFile: entryFile,
  };
}

/**
 * 构建入口文件包装的 prompt
 */
function buildEntryFilePrompt(fileName, originalContent, funcName) {
  return `请为以下 Python 文件添加入口函数包装。

## 原始文件: ${fileName}
\`\`\`python
${originalContent}
\`\`\`

## 要求
1. 添加一个 \`${funcName}()\` 函数作为程序入口
2. 将原来直接执行的代码包装到 \`${funcName}()\` 函数中
3. 在文件末尾添加 \`if __name__ == "__main__":\` 块调用该函数
4. 保持原有的 import 语句在文件顶部
5. 不要改变程序的功能逻辑
6. 如果原来已经有 \`if __name__ == "__main__":\` 块，将其内容移到 \`${funcName}()\` 函数中

## 示例
原始代码:
\`\`\`python
import sys
print("Hello")
do_something()
\`\`\`

修改后:
\`\`\`python
import sys

def main():
    print("Hello")
    do_something()

if __name__ == "__main__":
    main()
\`\`\`

请直接输出修改后的完整 Python 代码：`;
}

function buildAIPrompt(
  repo,
  fileContents,
  pythonFiles,
  pythonFileContents,
  readmeContent,
  allRootFiles,
  latestVersion,
  baseTemplate
) {
  let prompt = `请为以下 Python 项目生成 pyproject.toml 文件：

## 项目信息
- 名称: ${repo.name}
- 描述: ${repo.description || "无"}
- 版本: ${latestVersion}（来自 GitHub Releases，必须使用此版本号）
- 作者: ${repo.owner.login}
- 仓库地址: ${repo.html_url}
- 主题标签: ${JSON.stringify(repo.topics || [])}
`;

  // README 优先展示（通常包含使用说明和入口点信息）
  if (readmeContent) {
    prompt += `\n## README 文档（重要！优先从这里提取使用方式和入口点）\n`;
    prompt += `\`\`\`\n${smartTruncateReadme(readmeContent, TOKEN_BUDGET.readme)}\n\`\`\`\n`;
  }

  // 显示根目录所有文件（帮助 AI 判断 include）
  if (allRootFiles.length > 0) {
    prompt += `\n## 仓库根目录文件结构\n`;
    prompt += `\`\`\`\n${allRootFiles.join("\n")}\n\`\`\`\n`;
  }

  // 智能截取配置文件
  if (Object.keys(fileContents).length > 0) {
    const truncatedConfigs = truncateFilesByBudget(fileContents, TOKEN_BUDGET.configFiles);
    prompt += `\n## 现有配置文件\n`;
    for (const [fileName, content] of Object.entries(truncatedConfigs)) {
      prompt += `\n### ${fileName}\n\`\`\`\n${content}\n\`\`\`\n`;
    }
  }

  if (pythonFiles.length > 0) {
    prompt += `\n## 根目录 Python 文件\n${pythonFiles.join(", ")}\n`;
  }

  // 智能截取 Python 文件内容（优先保留入口点相关代码）
  if (Object.keys(pythonFileContents).length > 0) {
    const truncatedPython = truncateFilesByBudget(
      pythonFileContents,
      TOKEN_BUDGET.pythonFiles,
      smartTruncatePython
    );
    prompt += `\n## Python 文件源码（备用：当 README 无法确定入口时参考）\n`;
    for (const [fileName, content] of Object.entries(truncatedPython)) {
      prompt += `\n### ${fileName}\n\`\`\`python\n${content}\n\`\`\`\n`;
    }
  }

  prompt += `
## 要求
1. 使用 hatchling 作为构建后端
2. 根据现有依赖文件（如 requirements.txt）提取 dependencies

3. **入口点推断规则（按优先级）**：
   a. **首先从 README 提取入口脚本**：查找使用示例如 \`python xxx.py\`、\`uvx ${repo.name}\`、命令行示例等
   b. **其次分析入口脚本代码**：在源码中查找实际定义的入口函数

   **重要：入口点必须指向源码中实际存在的函数！**
   - 格式: \`命令名 = "模块名:函数名"\`
   - 必须确认该函数在源码中有 \`def 函数名():\` 定义
   - 常见入口函数: main(), run(), cli(), app(), start()
   - 例如源码有 \`def run():\`，并在入口脚本代码下方 \`if __name__ == "__main__"\` 中或之直接调用时，则用 \`${repo.name} = "模块名:run"\`

4. **根据上一步的推断**
  4.1 查不出入口脚本
  4.2 获取入口脚本，查不出入口函数
  4.3 获取入口脚本，查出入口函数

  仅当非 4.3 时才使用 TODO 作为[project.scripts]部分：
\`\`\`toml
[project.scripts]
# TODO: 请设置入口点，格式: 命令名 = "模块名:函数名"
# ${repo.name} = "模块名:函数名"
\`\`\`

5. **打包包含文件 [tool.hatch.build.targets.wheel]**：
   - 仔细阅读 README，找出程序运行所需的配置文件（如 config.yaml, settings.json, .env.example 等）
   - 找出程序需要的资源文件（如模板、数据文件、静态资源等）
   - 将这些文件加入 include 列表
   - 示例：
\`\`\`toml
[tool.hatch.build.targets.wheel]
include = [
    "${repo.name.replace(/-/g, "_")}/**",
    "config.yaml",  # README 中提到的配置文件
]
\`\`\`

6. 保留以下基本结构，但根据项目实际情况优化：

${baseTemplate}

请直接输出完整的 pyproject.toml 内容：`;

  return prompt;
}

function createPC(repo, latestVersion = "0.0.1") {
  const owner = repo.owner;
  const pyprojectContent = pyprojectTemplate
    .replace(/version = ".*"/, `version = "${latestVersion}"`)
    .replace(/name = ".*"/, `name = "${repo.name}"`)
    .replace(/description = ".*"/, `description = "${repo.description || ""}"`)
    .replace(
      /authors = \[\s*\{[^}]*\},?\s*\]/s,
      `authors = [\n    {name = "${owner.name || owner.login}", email = "${owner.email || ""}"},\n]`
    )
    .replace(/keywords = \[.*\]/, `keywords = ${JSON.stringify(repo.topics || [])}`)
    .replace(/Repository = ".*"/, `Repository = "${repo.html_url}"`)
    .replace(/Releases = ".*"/, `Releases = "${repo.html_url}/releases"`);
  return pyprojectContent;
}

module.exports = {
  createPCbyAI,
  createPC,
  buildAIPrompt,
};
