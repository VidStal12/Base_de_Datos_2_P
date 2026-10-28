import { useSyncExternalStore } from 'react';

// Un solo temporizador para TODAS las cuentas regresivas de la página (en vez de uno por tarjeta): se enciende con la
// primera tarjeta que lo pide, late una vez por segundo y se apaga cuando ya nadie lo usa. Devuelve la hora actual en
// milisegundos; quien la reciba se redibuja cada segundo, y todas las cuentas cambian a la vez.
const escuchas = new Set();
let temporizador = null;
let ahora = Date.now();

function latir() {
  ahora = Date.now();
  escuchas.forEach((avisar) => avisar());
}

function suscribir(avisar) {
  escuchas.add(avisar);
  if (temporizador === null) temporizador = setInterval(latir, 1000);
  return () => {
    escuchas.delete(avisar);
    if (escuchas.size === 0) {
      clearInterval(temporizador);
      temporizador = null;
    }
  };
}

function instantanea() {
  // Con el temporizador apagado nadie actualiza la hora guardada y puede ser de hace rato: la primera tarjeta en
  // dibujarse mostraría una cuenta atrasada hasta el primer latido. Dentro del mismo segundo devuelve siempre el mismo
  // valor, que es lo que useSyncExternalStore exige entre dos lecturas seguidas.
  if (temporizador === null && Date.now() - ahora > 1000) ahora = Date.now();
  return ahora;
}

export function useAhora() {
  return useSyncExternalStore(suscribir, instantanea, instantanea);
}
