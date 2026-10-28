// Entry for the <script> build: everything on window.Bunwrite.
import * as Bunwrite from './index';

(globalThis as unknown as { Bunwrite: typeof Bunwrite }).Bunwrite = Bunwrite;
