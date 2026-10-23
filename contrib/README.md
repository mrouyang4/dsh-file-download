# contrib

`github-actions-check.yml` 是仓库的 CI 工作流，**没有放在 `.github/workflows/` 下**是历史原因：首次推送时用的 OAuth token 缺 `workflow` 权限，GitHub 拒绝创建该目录下的文件。

要启用 Actions，二选一：

**A. 补权限后直接搬过去**

```bash
gh auth refresh -s workflow          # 或在 Settings → Developer settings 建带 workflow 的 PAT
mkdir -p .github/workflows
git mv contrib/github-actions-check.yml .github/workflows/check.yml
git commit -m "ci: enable GitHub Actions" && git push
```

**B. 用网页上传**

打开 `https://github.com/mrouyang4/dsh-file-download/new/main/.github/workflows`，文件名 `check.yml`，粘贴 `contrib/github-actions-check.yml` 的内容提交。

不启用 Actions 也不影响使用：`scripts/check.sh` 在本地跑完全相同的检查（语法、JSON、zip 写入器冒烟测试）。
