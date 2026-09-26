// Older copy journals could contain a serialized configuration up to their
// 384 KiB aggregate limit. Readers retain that bounded recovery envelope.
export const MAX_NATIVE_CONFIG_BYTES = 384 * 1024;
// New copies remain smaller, so an accepted output is safely portable.
export const MAX_COPIED_NATIVE_CONFIG_BYTES = 256 * 1024;
