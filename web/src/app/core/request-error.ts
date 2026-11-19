export function requestError(error: any): string {
  const code = error?.error?.error?.code ?? error?.error?.code ?? error?.code;
  if (code === 'ORGANIZATION_CHANGED') return '';
  if (code === 'MEMBERSHIP_REVOKED') return 'Tu acceso a esta organización terminó. Vuelve a tu organización personal.';
  if (code === 'VERSION_CONFLICT') return 'La información cambió. Actualiza y vuelve a revisar antes de confirmar.';
  if (error?.status === 403) return 'Tu acceso actual no permite esta acción.';
  return error?.error?.error?.message ?? error?.error?.message ?? error?.message ?? 'No se pudo completar la operación. Vuelve a intentarlo.';
}
