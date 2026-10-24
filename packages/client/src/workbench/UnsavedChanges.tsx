import { createContext, useContext, useEffect, type ReactNode } from 'react';

type Register = (token: object, dirty: boolean) => () => void;
const Context = createContext<Register | undefined>(undefined);

/** Ephemeral form presence only; no content, identity or authorization is stored here. */
export function UnsavedChangesBoundary({
  register,
  children,
}: {
  register: Register;
  children: ReactNode;
}) {
  return <Context.Provider value={register}>{children}</Context.Provider>;
}

export function useUnsavedChanges(dirty: boolean) {
  const register = useContext(Context);
  useEffect(() => register?.({}, dirty), [register, dirty]);
}
