import * as z from 'zod';

// The webview runs under a Content Security Policy without 'unsafe-eval'. Zod normally probes
// whether it may compile validators with `new Function`; that probe is blocked and reported as a
// policy violation. Telling it up front not to try keeps the console clean. Import this first.
z.config({ jitless: true });
