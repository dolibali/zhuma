#!/usr/bin/env node
/** Public fixed-source preparation only. The target OS builds its own native runtime. */
import { parseArgs } from 'node:util';
import { prepareProductSources } from '../desktop/prepare.mjs';

const { values } = parseArgs({
  options: {
    'refresh-assets': { type: 'boolean', default: false },
  },
});
prepareProductSources({ kind: 'server', refresh: values['refresh-assets'] });
