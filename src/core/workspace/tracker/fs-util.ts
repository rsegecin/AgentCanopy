import { constants, promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

export { errorCode, isVanished } from '../store/internal';

/** Atomic write that sets the final mode on the file before it is moved into place. */
export async function writeFileAtomicWithMode(
  path: string,
  data: Uint8Array,
  mode: number,
): Promise<void> {
  const tmp = join(dirname(path), `.tmp-${randomBytes(8).toString('hex')}`);
  const handle = await fs.open(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(data);
    if (process.platform !== 'win32') await handle.chmod(mode);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.rm(tmp, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}
