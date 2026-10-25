const { Schema, model } = require('mongoose');

// El registro de cambios de permisos y de accesos denegados (IA/ADR-007 §9). Solo se INSERTA: el rol `app_tiendaya`
// de MongoDB no puede modificar ni borrar nada de esta colección (config/mongoCuentas.js), igual que el historial
// de productos (ADR-003), así que ni un bug ni quien se haga con el servidor web pueden reescribir quién cambió qué.
//
//   regla          un cambio de permiso de un rol en una ruta (antes/después)
//   restaurar      se volvió a lo que declara el código (una ruta, un rol o todo)
//   rol_cuenta     se cambió el rol de una cuenta
//   rol_creado     / rol_eliminado   un rol nuevo, o uno que se borró
//   denegacion     un rol sin permiso intentó una ruta (ACL_DENEGADO); vence a los 90 días
//
// De quién actuó solo se guarda el id y el rol: el nombre y el correo se resuelven al LEER (así no se copian datos
// personales a un registro que no se puede borrar, y una cuenta eliminada se ve como tal).
const TIPOS = ['regla', 'restaurar', 'rol_cuenta', 'rol_creado', 'rol_eliminado', 'denegacion'];
const DIAS_DE_DENEGACIONES = 90;

const auditoriaAccesoSchema = new Schema(
  {
    tipo: { type: String, enum: TIPOS, required: true },
    fecha: { type: Date, required: true, default: Date.now },
    actor: { id: { type: Number }, rol: { type: String } },
    objetivo: { tipo: { type: String }, id: { type: String }, nombre: { type: String } },
    antes: { type: Schema.Types.Mixed },
    despues: { type: Schema.Types.Mixed },
    detalle: { type: String },
  },
  { versionKey: false }
);

auditoriaAccesoSchema.index({ fecha: -1 });
auditoriaAccesoSchema.index({ tipo: 1, fecha: -1 });
// Un cambio de permisos se conserva siempre; las denegaciones repetidas solo hacen falta un tiempo. El vencimiento
// lo hace el servidor de MongoDB por su cuenta, así que no necesita permiso de borrar.
auditoriaAccesoSchema.index(
  { fecha: 1 },
  { name: 'denegaciones_vencen', expireAfterSeconds: DIAS_DE_DENEGACIONES * 86400, partialFilterExpression: { tipo: 'denegacion' } }
);

const AuditoriaAcceso = model('AuditoriaAcceso', auditoriaAccesoSchema, 'auditoria_acceso');
AuditoriaAcceso.TIPOS = TIPOS;

module.exports = AuditoriaAcceso;
