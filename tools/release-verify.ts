/**
 * Release verification — is this version actually *released*, not just committed?
 *
 * ## Why this exists
 *
 * `npm run check` compares four **local** things (package.json, package-lock.json,
 * CHANGELOG's newest entry, the git tag). All four agreed while seventeen commits
 * and seventeen tags had never been pushed: the repository was internally
 * consistent and publicly empty. "Locally consistent" is not "released", and no
 * offline check can tell the difference — so this one talks to the remote.
 *
 * This is the definition of done for `CONTRIBUTING.md` §5, in executable form:
 *
 *   1. the working tree is clean;
 *   2. HEAD is tagged with the version in package.json;
 *   3. every tag carries its own version inside its own tree;
 *   4. nothing is left to push (no commits, no tags);
 *   5. the remote's tag set equals the local one, name for name.
 *
 *   npm run release:verify
 *
 * Exit code 0 means all five hold. Anything else prints the exact mismatch.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function git(args: string[], allowFailure = false): string {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (err) {
    if (allowFailure) return "";
    throw err;
  }
}

interface Finding {
  check: string;
  detail: string;
}

export class ReleaseVerifier {
  private readonly problems: Finding[] = [];
  private readonly notes: string[] = [];

  run(): number {
    const version = (JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")) as { version: string })
      .version;

    this.checkCleanTree();
    this.checkHeadTagged(version);
    this.checkTagsCarryVersion();
    this.checkNothingToPush();
    this.checkRemoteTagsMatch();

    console.log("\n发布校验 — npm run release:verify\n");
    for (const note of this.notes) console.log(`  · ${note}`);
    if (this.problems.length === 0) {
      console.log(`\n  ok   ${version} 已发布（本地与远端一致）\n`);
      return 0;
    }
    console.log(`\n  FAIL ${this.problems.length} 项未满足：\n`);
    for (const p of this.problems) console.log(`  [${p.check}] ${p.detail}\n`);
    return 1;
  }

  private checkCleanTree(): void {
    const dirty = git(["status", "--porcelain"]);
    if (dirty) {
      this.problems.push({
        check: "clean-tree",
        detail: `工作区有未提交改动：\n    ${dirty.split("\n").slice(0, 8).join("\n    ")}`,
      });
    } else {
      this.notes.push("工作区干净");
    }
  }

  private checkHeadTagged(version: string): void {
    const head = git(["rev-parse", "HEAD"]);
    const tagged = git(["rev-list", "-n", "1", `v${version}`], true);
    if (!tagged) {
      this.problems.push({
        check: "head-tagged",
        detail: `v${version} 还没有 tag —— 先 git tag v${version} 再发布`,
      });
      return;
    }
    if (tagged !== head) {
      this.problems.push({
        check: "head-tagged",
        detail: `v${version} 指向 ${tagged.slice(0, 7)}，而 HEAD 是 ${head.slice(0, 7)}`,
      });
      return;
    }
    this.notes.push(`HEAD 已打 tag v${version}`);
  }

  private checkTagsCarryVersion(): void {
    const tags = git(["tag", "--list", "v*"]).split("\n").filter(Boolean);
    const mismatched: string[] = [];
    for (const tag of tags) {
      const name = tag.replace(/^v/, "");
      const pkg = JSON.parse(git(["show", `${tag}:package.json`])) as { version?: string };
      const changelog = git(["show", `${tag}:CHANGELOG.md`], true);
      const newest = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1];
      if (pkg.version !== name) mismatched.push(`${tag}: package.json = ${pkg.version}`);
      else if (newest && newest !== name) mismatched.push(`${tag}: CHANGELOG 首条 = ${newest}`);
    }
    if (mismatched.length) {
      this.problems.push({
        check: "tag-content",
        detail: `${mismatched.length} 个 tag 的内容不自带该版本：\n    ${mismatched.slice(0, 8).join("\n    ")}`,
      });
    } else {
      this.notes.push(`${tags.length} 个 tag 的内容均自带版本`);
    }
  }

  private checkNothingToPush(): void {
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], true);
    if (!upstream) {
      this.problems.push({
        check: "push",
        detail: `${branch} 没有设置上游分支 —— 先 git push -u origin ${branch}`,
      });
      return;
    }
    const ahead = git(["rev-list", "--count", `${upstream}..HEAD`]);
    if (ahead !== "0") {
      this.problems.push({
        check: "push",
        detail: `${ahead} 个提交未推送 —— git push origin ${branch}`,
      });
    } else {
      this.notes.push(`${branch} 与 ${upstream} 同步`);
    }
  }

  private checkRemoteTagsMatch(): void {
    const remote = git(["ls-remote", "--tags", "origin"], true);
    if (!remote) {
      this.problems.push({
        check: "remote-tags",
        detail: "读不到远端 tag（git ls-remote --tags origin 无输出）：网络或认证问题，不能确认已发布",
      });
      return;
    }
    const remoteTags = new Set(
      remote
        .split("\n")
        .map((line) => line.split("refs/tags/")[1] ?? "")
        .filter((name) => name && !name.endsWith("^{}")),
    );
    const localTags = git(["tag", "--list", "v*"]).split("\n").filter(Boolean);

    const missing = localTags.filter((tag) => !remoteTags.has(tag));
    const extra = [...remoteTags].filter((tag) => !localTags.includes(tag));

    if (missing.length) {
      this.problems.push({
        check: "remote-tags",
        detail: `${missing.length} 个 tag 未推送：${missing.slice(0, 10).join(", ")} —— git push origin --tags`,
      });
    }
    if (extra.length) {
      this.problems.push({
        check: "remote-tags",
        detail: `远端有 ${extra.length} 个本地没有的 tag：${extra.slice(0, 10).join(", ")} —— 先 git fetch --tags`,
      });
    }
    if (!missing.length && !extra.length) {
      this.notes.push(`远端 tag 与本地一致（${localTags.length} 个）`);
    }
  }
}

function main(): void {
  process.exit(new ReleaseVerifier().run());
}

void main();
