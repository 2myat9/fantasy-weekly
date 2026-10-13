// Retrying a read of a source. The sources are public endpoints that fail now
// and then, and ESPN's are unofficial, so one failed read is not taken as the
// source being down.

// How long to wait before each further attempt. Every attempt is an outbound
// request, of which the free plan allows one invocation 50, so there are few.
const PAUSES_MS = [200, 600];

/**
 * Reads a source, and reads it again after a pause when the read fails. The
 * error of the last attempt is thrown when none succeeds.
 */
export async function retried<T>(read: () => Promise<T>): Promise<T> {
  for (const pause of PAUSES_MS) {
    try {
      return await read();
    } catch (error) {
      console.error("A read of a source failed and is tried again", error);
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
  return read();
}
