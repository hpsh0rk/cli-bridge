#!/usr/bin/env node
import { main } from '../src/cli.js';

main().catch((e) => {
  console.error(`错误：${e?.message || e}`);
  process.exit(1);
});
