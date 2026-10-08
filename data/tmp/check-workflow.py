"""
CI 工作流的落地前校验（本地跑，避免浪费一次 Action 运行）。

做四件事：
  1. 用真 YAML 解析器解析（不用正则猜结构）
  2. 核对关键结构：触发器、权限、每个 job 的 runs-on / steps / needs
  3. 联网确认每个 `uses:` 引用的 action **在这个 major 版本上真的存在**
     —— 写错一个版本号，CI 会在拉 action 那一步就红，白等一轮
  4. 把每段 `run:` 抽出来做 `bash -n` 语法检查（先把 ${{ }} 占位替换掉，
     否则 bash 会把它们当成非法的 ${...} 展开）

⚠️ 读的是**入库形态**（`git show :path`），不是磁盘上的工作区文件。
   在 Windows + `core.autocrlf=true` 下，磁盘上永远是 CRLF、blob 里是 LF；
   拿工作区文件去跑 bash -n 会得到一堆假的 `$'\r'` 语法错。
   而 GitHub 拿到的是 blob —— 所以校验也必须对着 blob。
"""
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
REL = ".github/workflows/docker-image.yml"
WF = ROOT / REL

failed = []


def check(name, ok, extra=""):
    print(("PASS  " if ok else "FAIL  ") + name + (f"  {extra}" if extra else ""))
    if not ok:
        failed.append(name)


def committed_text():
    """取入库形态：优先暂存区版本，其次 HEAD，最后退化成「读磁盘并把 CRLF 归一为 LF」。"""
    for spec in (f":{REL}", f"HEAD:{REL}"):
        p = subprocess.run(["git", "show", spec], cwd=ROOT, capture_output=True)
        if p.returncode == 0:
            return p.stdout.decode("utf-8", "replace"), spec
    return WF.read_text(encoding="utf-8").replace("\r\n", "\n"), "工作区文件（已归一 CRLF）"


raw, source = committed_text()
print(f"（校验对象：{source}）")
print(f"（入库形态含 CR：{raw.count(chr(13))} 个）\n")
check_no_cr = raw.count("\r") == 0
check("入库形态不含 CR（否则 Linux 上的 run 脚本会崩）", check_no_cr)

# ---------- 1. 解析 ----------
try:
    doc = yaml.safe_load(raw)
except yaml.YAMLError as exc:
    print(f"FAIL  YAML 解析失败: {exc}")
    sys.exit(1)
check("YAML 可解析", isinstance(doc, dict))

# PyYAML 走 YAML 1.1，把裸 `on` 解析成布尔 True —— 这是众所周知的坑，两种都认
triggers = doc.get("on", doc.get(True))
check("有 name", isinstance(doc.get("name"), str))
check("on 是映射（不是被解析成字符串的裸值）", isinstance(triggers, dict), str(type(triggers).__name__))
check("push 触发器存在", "push" in triggers)
check("pull_request 触发器存在", "pull_request" in triggers)
check("workflow_dispatch 存在且带 platforms 输入",
      isinstance(triggers.get("workflow_dispatch"), dict)
      and "platforms" in (triggers["workflow_dispatch"].get("inputs") or {}))
check("tag 触发含 v*", "v*" in ((triggers.get("push") or {}).get("tags") or []))

jobs = doc.get("jobs") or {}
check("两个 job：build / smoke", set(jobs) == {"build", "smoke"}, ", ".join(jobs))

build, smoke = jobs.get("build", {}), jobs.get("smoke", {})

for jn, job in (("build", build), ("smoke", smoke)):
    check(f"{jn}: 有 runs-on", isinstance(job.get("runs-on"), str))
    check(f"{jn}: 有 timeout-minutes", isinstance(job.get("timeout-minutes"), int))
    check(f"{jn}: steps 是非空列表", isinstance(job.get("steps"), list) and len(job["steps"]) > 0,
          f"{len(job.get('steps') or [])} 个")
    check(f"{jn}: 每个 step 都是映射", all(isinstance(s, dict) for s in job.get("steps") or []))

check("build: packages: write", (build.get("permissions") or {}).get("packages") == "write")
check("smoke: 依赖 build", smoke.get("needs") == "build")
check("smoke: 只在非 PR 跑",
      "pull_request" in str(smoke.get("if")) and "!=" in str(smoke.get("if")))
check("build 输出 image / digest / ref", {"image", "digest", "ref"} <= set(build.get("outputs") or {}))

# 找 build-push 那一步，核对关键开关
bp = next((s.get("with") or {} for s in build["steps"]
           if str(s.get("uses", "")).startswith("docker/build-push-action")), None)
check("存在 build-push step", bp is not None)
if bp:
    check("push 条件排除了 pull_request", "pull_request" in str(bp.get("push")))
    check("platforms 来自计算步骤", "steps.platforms.outputs.value" in str(bp.get("platforms")))
    check("provenance 已关闭", bp.get("provenance") is False)
    check("启用了 gha 缓存", "type=gha" in str(bp.get("cache-from")) and "type=gha,mode=max" in str(bp.get("cache-to")))
    check("tags / labels 都接了 metadata 输出",
          "steps.meta.outputs.tags" in str(bp.get("tags")) and "steps.meta.outputs.labels" in str(bp.get("labels")))
    # metadata-action 会把 licenses 填成空、把 version 填成分支名 → 必须手工覆盖
    labels = str(bp.get("labels"))
    check("手工覆盖 licenses（否则 Dockerfile 里的 MIT 被空值盖掉）",
          "image.licenses=MIT" in labels)
    check("手工覆盖 version（否则会写成分支名 main）",
          "image.version=${{ steps.ver.outputs.value }}" in labels)
    check("版本覆盖步骤存在", any(s.get("id") == "ver" for s in build["steps"]))

meta = next((s.get("with") or {} for s in build["steps"]
             if str(s.get("uses", "")).startswith("docker/metadata-action")), None)
check("metadata 同时产出 sha- 长标签（冒烟作业要靠它算出标签名）",
      meta is not None and "type=sha,format=long,prefix=sha-" in str(meta.get("tags")))
check("默认分支额外打 latest 标签", meta is not None and "value=latest" in str(meta.get("tags")))

# 平台策略：常规 push 只 amd64，tag / 手动才多架构
plat = next((s for s in build["steps"] if s.get("id") == "platforms"), None)
check("存在平台决策步骤", plat is not None)
if plat:
    body = plat.get("run", "")
    check("平台策略：按 tag 判定是否多架构", "GITHUB_REF_TYPE" in body and "tag" in body)
    check("平台策略：可被手动输入覆盖", "REQUESTED" in body)
    check("平台策略：默认回落到纯 amd64", "value=linux/amd64\n" in body + "\n" or "value=linux/amd64" in body)
    check("平台策略：多架构取值正确", "linux/amd64,linux/arm64" in body)

# ---------- 3. 每个 uses 引用的 action 版本存在 ----------
uses = []
for job in jobs.values():
    for s in job.get("steps") or []:
        u = s.get("uses")
        if u:
            uses.append(u)
check("uses 都带版本（没有裸 latest / 无版本）", all("@" in u for u in uses), ", ".join(uses))

H = {"User-Agent": "workflow-check", "Accept": "application/vnd.github+json"}
for u in sorted(set(uses)):
    repo, _, ver = u.partition("@")
    if not repo.count("/") == 1:
        check(f"uses 格式合法 {u}", False)
        continue
    url = f"https://api.github.com/repos/{repo}/git/ref/tags/{ver}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=H), timeout=20) as r:
            ok = r.status == 200
        check(f"action 版本存在 {u}", ok)
    except urllib.error.HTTPError as e:
        # 403/429 是匿名 API 限流（60 次/小时），不是「版本不存在」——
        # 把它当失败会让人误以为工作流写错了版本号。
        if e.code in (403, 429):
            print(f"SKIP  action 版本存在 {u}  （API 限流 HTTP {e.code}，未能确认）")
        else:
            check(f"action 版本存在 {u}", False, f"HTTP {e.code}")
    except Exception as e:  # 网络问题不算校验失败，但要如实说
        print(f"SKIP  action 版本存在 {u}  （网络不可用：{type(e).__name__}）")

# ---------- 4. run 块的 bash 语法 ----------
run_blocks = []
for jn, job in jobs.items():
    for i, s in enumerate(job.get("steps") or [], 1):
        if "run" in s:
            run_blocks.append((f"{jn}#{i}", s["run"]))

check("抽到 10 段 run", len(run_blocks) == 10, f"{len(run_blocks)} 段")

for label, script in run_blocks:
    # ${{ ... }} 对 bash 是非法展开，先换成哑值再检查语法
    safe = re.sub(r"\$\{\{.*?\}\}", "EXPR", script, flags=re.S)
    # 必须传 bytes：Windows 上 text=True 会把 \n 翻成 \r\n，
    # 于是 bash 抱怨 `$'do\r'`，得到一串与入库内容无关的假失败。
    p = subprocess.run(["bash", "-n"], input=safe.encode("utf-8"),
                       capture_output=True)
    detail = p.stderr.decode("utf-8", "replace").strip().splitlines()
    check(f"bash 语法 {label}", p.returncode == 0, detail[0] if detail else "")

# ---------- 5. 与仓库其余部分的配合 ----------
check("Dockerfile 存在", (ROOT / "Dockerfile").is_file())
check(".dockerignore 存在", (ROOT / ".dockerignore").is_file())
pkg = yaml.safe_load((ROOT / "package.json").read_text(encoding="utf-8"))
check("根 package.json 有 version（冒烟作业会比对它）", bool(pkg.get("version")), str(pkg.get("version")))

print()
if failed:
    print(f"{len(failed)} 项失败：")
    for f in failed:
        print(f"  - {f}")
    sys.exit(1)
print("全部通过")
