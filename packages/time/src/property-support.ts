import fc from "fast-check";

/** A fixed seed, so a property failure replays the same way on every machine. */
export const PROPERTY_SEED = 20_260_901;

export const propertyParameters = <Ts>(): fc.Parameters<Ts> => ({
  seed: PROPERTY_SEED,
});

export const assertProperty = <Ts>(property: fc.IProperty<Ts>): void => {
  fc.assert(property, propertyParameters<Ts>());
};
