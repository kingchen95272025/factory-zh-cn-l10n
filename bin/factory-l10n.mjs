#!/usr/bin/env node
import { main } from '../scripts/cli/main.mjs';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = typeof code === 'number' ? code : 0;
  })
  .catch((error) => {
    console.error(`错误：${error.message}`);
    if (process.env.FACTORY_L10N_DEBUG) console.error(error.stack);
    process.exitCode = 1;
  });