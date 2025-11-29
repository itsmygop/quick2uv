const fs = require("fs");
const path = require("path");
const { createPCbyAI, createPC } = require("./model/pyproject-generator");

// Load templates - use process.cwd() for Vercel compatibility
const workflowContent = fs.readFileSync(path.join(process.cwd(), "assets/pypi.yml"), "utf8");

/**
 * This is the main entrypoint to your Probot app
 * @param {import('probot').Probot} app
 */
module.exports = (app) => {
  app.on("installation.created", async (context) => {
    context.log.info("Installation created:", context.payload.repositories);

    const ownerLogin = context.payload.installation.account.login;

    for (const repository of context.payload.repositories) {
      const repoName = repository.name;

      try {
        // Get full repository details
        const { data: repo } = await context.octokit.repos.get({ owner: ownerLogin, repo: repoName });

        // 1. Generate pyproject.toml content
        const { pyproject: pyprojectContent, entryFile, usedAI } = await createPyprojectContent(context, repo);

        // 2. Generate PR body content
        const aiWarning = usedAI ? "" : `(**⚠️ 注意**: AI 失效，请重点手动修改。)`;
        const entryFileNote = entryFile
          ? `\n> 📝 已自动为 \`${entryFile.path}\` 添加入口函数包装，请检查是否正确。\n`
          : "";
        const prBody = `
你好！我创建了此 PR，以此帮助你的项目使用 uv 进行更方便持续的 CI/CD：
---

### 1. 此 PR 期间，你需要做如下操作：

${entryFileNote}

1.  **文件复核**: 请转至 \`Files Changed\` 检查 \`pyproject.toml\` 的内容是否准确。如需调整，对 \`pyproject.toml\` 点击 \`Edit file\` 修改提交 commit 即可。 ${aiWarning}
2.  **PYPI设置**: [登入 PYPI](https://pypi.org/manage/projects/)（没有时请自行注册），然后[点击此处进行 pypi 授权信任 GitHub Actions 发布](https://pypi.org/manage/account/publishing/)，填写以下信息：
    - **PyPI Project Name**: \`${repo.name}\`
    - **Owner**: \`${ownerLogin}\`
    - **Repository name**: \`${repoName}\`
    - **Workflow name**: \`pypi.yml\`
3.  **合并此 PR，并删除此分支**。

> ⚠️注意：目前 bot 版本对 \`pyproject.toml\` 的 \`[project.scripts]\` 的处理暂不可靠。  
> 假如 bot 给的是 \`main:main\`，而你的入口脚本并没有 main 包起执行操作的话，请 PR 之后用 main 函数修改

---

### 2. 此 PR 之后操作

#### 2.1 部署发布：

今后可以通过推送 Git 标签轻松发布新版本：
\`\`\`bash
git tag v0.1.0 && git push origin v0.1.0
\`\`\`

#### 2.2 用户使用：

\`\`\`bash
uvx ${repo.name}
\`\`\`

#### 2.3 用户更新：
\`\`\`bash
uvx ${repo.name}@latest
\`\`\`
`;

        // 3. Git operations
        const base = repo.default_branch;
        const branch = `uvx-onboarding-${Date.now()}`;
        const prTitle = "一键接入 uvx 生态、优化发布流程";

        const { data: reference } = await context.octokit.git.getRef({
          owner: ownerLogin,
          repo: repoName,
          ref: `heads/${base}`,
        });

        await context.octokit.git.createRef({
          owner: ownerLogin,
          repo: repoName,
          ref: `refs/heads/${branch}`,
          sha: reference.object.sha,
        });

        // Create or update pyproject.toml
        await context.octokit.repos.createOrUpdateFileContents({
          owner: ownerLogin,
          repo: repoName,
          path: "pyproject.toml",
          message: "feat: add pyproject.toml for packaging",
          content: Buffer.from(pyprojectContent).toString("base64"),
          branch,
        });

        // Create or update entry file if needed (add main() wrapper)
        if (entryFile) {
          // Get existing file SHA for update
          let existingSha;
          try {
            const { data: existingFile } = await context.octokit.repos.getContent({
              owner: ownerLogin,
              repo: repoName,
              path: entryFile.path,
              ref: branch,
            });
            existingSha = existingFile.sha;
          } catch (e) {
            // File doesn't exist, will create new
          }

          await context.octokit.repos.createOrUpdateFileContents({
            owner: ownerLogin,
            repo: repoName,
            path: entryFile.path,
            message: `refactor: add main() entry function to ${entryFile.path}`,
            content: Buffer.from(entryFile.content).toString("base64"),
            branch,
            ...(existingSha && { sha: existingSha }),
          });
        }

        // Create workflow file
        await context.octokit.repos.createOrUpdateFileContents({
          owner: ownerLogin,
          repo: repoName,
          path: ".github/workflows/pypi.yml",
          message: "ci: add workflow to publish to pypi",
          content: Buffer.from(workflowContent).toString("base64"),
          branch,
        });

        // Create Pull Request
        await context.octokit.pulls.create({
          owner: ownerLogin,
          repo: repoName,
          title: prTitle,
          head: branch,
          base,
          body: prBody,
          maintainer_can_modify: true,
        });

        context.log.info(`PR created for ${ownerLogin}/${repoName}`);
      } catch (error) {
        context.log.error(`Failed to process repository ${repoName}: ${error.message}`);
      }
    }
  });
};

async function createPyprojectContent(context, repo) {
  try {
    const result = await createPCbyAI({
      octokit: context.octokit,
      repo,
      log: context.log,
    });
    return {
      pyproject: result.pyproject,
      entryFile: result.entryFile,
      usedAI: true,
    };
  } catch (error) {
    context.log.error(`AI generation failed, falling back to template: ${error.message}`);
    return {
      pyproject: createPC(repo),
      entryFile: null,
      usedAI: false,
    };
  }
}
