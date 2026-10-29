import { createEffect, onCleanup, type Accessor } from 'solid-js'

/**
 * Pilote un `<dialog>` natif ouvert en modal depuis un booleen.
 *
 * On passe par l'element natif plutot que par une div : le navigateur fournit
 * alors le piege a focus, la fermeture par Echap, le retour du focus au
 * declencheur, l'inertie du reste de la page et le fond assombri — tout ce
 * qu'on reecrirait moins bien a la main.
 *
 * L'element vient de l'appelant (`useTemplateRef`) plutot que d'ici : c'est lui
 * qui nomme la ref dans son template. Cote template, il reste a renvoyer la
 * fermeture native vers le booleen :
 * `@close="open = false" @cancel.prevent="open = false"`.
 */
export function useModalDialog(
  open: Accessor<boolean>,
  el: Accessor<HTMLDialogElement | undefined>
) {
  createEffect(
    () => [open(), el()] as const,
    ([on, dialog]) => {
    if (!dialog) return
    if (on && !dialog.open) dialog.showModal()
    else if (dialog.open) dialog.close()
    }
  )

  // le composant peut disparaitre alors que la boite est ouverte (changement de
  // vue) : un `<dialog>` laisse en modal bloquerait la page entiere
  onCleanup(() => {
    if (el()?.open) el()!.close()
  })
}
