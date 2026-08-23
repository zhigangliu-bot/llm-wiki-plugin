#!/usr/bin/env node
/**
 * init-vault.mjs — 一键初始化 Obsidian vault 为 llm-wiki-plugin 兼容结构(纯函数库)
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 创建目录(幂等)。返回 {created: bool, path}
 * 策略:先尝试 access,不存在再 mkdir recursive:true。
 * recursive:true 在目录已存在时不报错(Node 文档保证),但我们仍需要 access
 * 来告诉 caller "本次是否做了实际创建"——这是 spec 的契约。
 * 失败向上抛(权限拒绝 / 路径无效),由 caller 处理。
 */
export async function ensureDir(dirPath) {
  try {
    await fs.access(dirPath);
    return { created: false, path: dirPath };
  } catch {
    // 不存在,继续创建
  }
  await fs.mkdir(dirPath, { recursive: true });
  return { created: true, path: dirPath };
}

/**
 * copy-if-missing。返回 {action: 'copied'|'skipped'|'failed', src, dst, error?}
 * 失败时 error.kind 区分 mkdir 阶段失败('mkdir-failed')和 copyFile 阶段失败('copy-failed'),
 * error.code 透传 Node.js errno.code(EACCES/ENOENT/ENOSPC 等)。
 * 失败永不抛异常,返回结果由 caller 决定 retry / abort。
 */
export async function copyIfMissing(src, dst) {
  try {
    await fs.access(dst);
    return { action: 'skipped', src, dst };
  } catch {
    // dst 不存在 → 拷贝
  }
  try {
    await fs.mkdir(path.dirname(dst), { recursive: true });
  } catch (e) {
    return { action: 'failed', src, dst, error: { kind: 'mkdir-failed', code: e.code, message: e.message } };
  }
  try {
    await fs.copyFile(src, dst);
    return { action: 'copied', src, dst };
  } catch (e) {
    return { action: 'failed', src, dst, error: { kind: 'copy-failed', code: e.code, message: e.message } };
  }
}