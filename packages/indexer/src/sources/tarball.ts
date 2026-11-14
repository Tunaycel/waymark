import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { extract } from 'tar-stream';
import { DEFAULT_LIMITS, type SourceFile, type TruncatableSource } from '../types.ts';

export interface TarballOptions {
  maxFileBytes?: number;
  /**
   * Upper bound on the declared size of all entries, read or skipped. Reaching it ends the stream
   * early and marks the source `truncated`: it bounds decompression work (gzip bombs, repositories
   * with gigabytes of committed binaries) without making such repositories unindexable.
   */
  maxArchiveBytes?: number;
  /** Leading path segments to drop. GitHub tarballs wrap everything in `owner-repo-sha/`. */
  stripComponents?: number;
}

/**
 * Streams the regular files of a `.tar.gz` (e.g. GitHub's repository tarball) without writing
 * anything to disk. Symlinks, hard links, and devices are skipped. Large files are drained without
 * being buffered. Check `truncated` after iterating.
 */
export function tarballSource(
  input: AsyncIterable<Uint8Array> | NodeJS.ReadableStream,
  options: TarballOptions = {},
): TruncatableSource {
  const source = {
    truncated: false,
    [Symbol.asyncIterator]: () => entries(input, options, source),
  };
  return source;
}

async function* entries(
  input: AsyncIterable<Uint8Array> | NodeJS.ReadableStream,
  {
    maxFileBytes = DEFAULT_LIMITS.maxFileBytes,
    maxArchiveBytes = 2 * 1024 * 1024 * 1024,
    stripComponents = 1,
  }: TarballOptions,
  state: { truncated: boolean },
): AsyncGenerator<SourceFile> {
  const tar = extract();
  let failure: unknown = null;
  const readable = input instanceof Readable ? input : Readable.from(input);
  // Declared entry sizes don't cover everything gunzip produces (e.g. gigabytes of zero padding
  // after the end-of-archive marker), so the decompressed stream itself is metered too.
  let inflated = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      inflated += chunk.byteLength;
      if (inflated > maxArchiveBytes) done(new LimitReached());
      else done(null, chunk);
    },
  });
  const piping = pipeline(readable, createGunzip(), meter, tar).catch((err: unknown) => {
    failure = err;
    tar.destroy(err as Error);
  });

  let declared = 0;
  let wrapper: string | null = null;
  try {
    for await (const entry of tar) {
      const { header } = entry;
      const size = header.size ?? 0;
      declared += size;
      if (declared > maxArchiveBytes) {
        state.truncated = true;
        return; // `finally` stops the download and decompression
      }

      const isFile = header.type === 'file' || header.type === 'contiguous-file';
      const segments = header.name.split('/');
      // Everything must live under the wrapper directory of the first entry; an entry named
      // `../x` or `/etc/x` would otherwise be re-rooted into the repository by stripping.
      const top = segments.slice(0, stripComponents).join('/');
      if (wrapper === null && (isFile || header.type === 'directory')) wrapper = top;
      const path = segments.slice(stripComponents).join('/');
      if (!isFile || path === '' || top !== wrapper) {
        entry.resume();
        continue;
      }

      if (size > maxFileBytes) {
        entry.resume();
        yield { path, size, content: null };
        continue;
      }

      const chunks: Uint8Array[] = [];
      let received = 0;
      for await (const chunk of entry as AsyncIterable<Uint8Array>) {
        received += chunk.byteLength;
        if (received > size) throw new Error(`Tar entry ${path} is larger than its header says`);
        chunks.push(chunk);
      }
      yield { path, size, content: concat(chunks, received) };
    }
    await piping;
    if (failure instanceof LimitReached) state.truncated = true;
    else if (failure) throw failure;
  } catch (err) {
    if (!(err instanceof LimitReached || failure instanceof LimitReached)) throw err;
    state.truncated = true;
  } finally {
    // Stops downloading and decompressing when the consumer stops early or something failed.
    tar.destroy();
    if ('destroy' in readable && typeof readable.destroy === 'function') readable.destroy();
  }
}

class LimitReached extends Error {
  constructor() {
    super('archive size limit reached');
    this.name = 'LimitReached';
  }
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
