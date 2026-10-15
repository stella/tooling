/** Invalid test setup or an impossible internal state. */
export const panic = (message: string): never => {
  throw new Error(message);
};
