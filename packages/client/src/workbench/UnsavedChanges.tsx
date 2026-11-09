import { createContext, useContext, useEffect, type ReactNode } from 'react';

/** `form` is a draft inside the page. It does not by itself block sidebar navigation. */
export type UnsavedChangeScope = 'page' | 'form';
type Register = (token: object, dirty: boolean, scope?: UnsavedChangeScope) => () => void;
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

export function useUnsavedChanges(dirty: boolean, scope: UnsavedChangeScope = 'page') {
  const register = useContext(Context);
  useEffect(() => register?.({}, dirty, scope), [register, dirty, scope]);
}
