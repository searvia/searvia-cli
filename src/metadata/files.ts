import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { naturalCompare } from '../core/util.js';

/** Store locale folder names: en-US, tr, zh-Hans, pt-BR, es-419… (fastlane uses the store's own codes). */
export const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?(-[A-Z]{2})?$/;

export function readText(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
}

export function writeText(path: string, value: string | null | undefined): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value ? `${value.replace(/\r\n?/g, '\n').trim()}\n` : '');
}

export function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.') && statSync(join(dir, name)).isDirectory())
    .sort(naturalCompare);
}

export function localeDirs(dir: string, exclude: string[] = []): string[] {
  return listDirs(dir).filter((name) => LOCALE_PATTERN.test(name) && !exclude.includes(name));
}

const IMAGE = /\.(png|jpe?g)$/i;

export function listImages(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => IMAGE.test(name) && !name.startsWith('.') && statSync(join(dir, name)).isFile())
    .sort(naturalCompare)
    .map((name) => join(dir, name));
}
