/**
 * The built-in guide: an illustrated walkthrough (shown on first start and
 * from the "? Aide" button) and one-time contextual tips.
 * Texts live here so they can later come from a signed content update.
 */

export const GUIDE_STEPS = [
  {
    art: "art/welcome.svg",
    title: "Bienvenue !",
    text: "Cette application range vos livres sur l'ordinateur et sur votre liseuse. Tout se fait avec de gros boutons, et vous ne pouvez rien casser.",
  },
  {
    art: "art/plug.svg",
    title: "Brancher la liseuse",
    text: "Branchez la liseuse sur l'ordinateur avec son câble. Après quelques secondes, l'application affiche « ✓ Liseuse détectée ». Vous n'avez rien d'autre à faire.",
  },
  {
    art: "art/add.svg",
    title: "Ajouter un livre",
    text: "Quand vous téléchargez un livre, l'application le remarque et vous propose de l'ajouter. Vous pouvez aussi faire glisser un livre sur l'écran de l'ordinateur, ou cliquer sur « ＋ Ajouter un livre ».",
  },
  {
    art: "art/put.svg",
    title: "Mettre un livre dans la liseuse",
    text: "Cliquez sur « Mettre dans la liseuse » sous le livre. Les livres au format EPUB sont transformés tout seuls pour la liseuse.",
  },
  {
    art: "art/trip.svg",
    title: "Avant un voyage",
    text: "Cochez les livres à emporter, même des dizaines d'un coup : l'application vous dit s'il y a assez de place. Puis cliquez sur « Mettre dans la liseuse ». Pour faire de la place, cochez des livres sur l'écran de la liseuse et cliquez sur « Ranger sur l'ordinateur » : ils restent sur l'ordinateur, et vos pages sont gardées.",
  },
  {
    art: "art/find.svg",
    title: "Retrouver un livre",
    text: "Tapez quelques lettres du titre ou de l'auteur dans « Chercher ». Les boutons « Dans la liseuse » et « Pas dans la liseuse » montrent où sont vos livres. Cliquez sur un livre pour le voir en grand, ou pour l'envoyer à un ami par e-mail.",
  },
  {
    art: "art/lights.svg",
    title: "Les pastilles de couleur",
    text: "Vert : parfait pour la liseuse. Orange : ça marche, mais le livre est lourd ou difficile à lire (souvent un PDF). Rouge : ce livre ne peut pas aller sur la liseuse.",
  },
  {
    art: "art/unplug.svg",
    title: "Quand vous avez fini",
    text: "Cliquez sur « J'ai fini, je débranche ». Quand le message vous le dit, débranchez le câble : vos livres apparaissent sur l'écran de la liseuse.",
  },
];

export const TIPS = {
  kindle: "Voici votre liseuse ! Ses livres s'affichent sur son écran. La barre en dessous montre la place qui reste.",
  firstPut: "Cliquez ici pour mettre ce livre dans votre liseuse.",
  take: "« Ranger » enlève le livre de la liseuse. Il reste sur l'ordinateur, et votre page est gardée.",
  tick: "Cochez plusieurs livres pour les mettre dans la liseuse en une seule fois.",
};

/** Wire the guide modal; returns open(). */
export function setupGuide(doc, { onClose } = {}) {
  const $ = (id) => doc.getElementById(id);
  const modal = $("guide");
  let i = 0;
  const show = () => {
    const s = GUIDE_STEPS[i];
    $("g-art").style.backgroundImage = `url(${s.art})`;
    $("g-title").textContent = s.title;
    $("g-text").textContent = s.text;
    $("g-prev").style.visibility = i === 0 ? "hidden" : "visible";
    $("g-next").textContent = i === GUIDE_STEPS.length - 1 ? "C'est parti !" : "Suivant →";
    $("g-dots").replaceChildren(
      ...GUIDE_STEPS.map((_, k) => Object.assign(doc.createElement("i"), { className: k === i ? "on" : "" })),
    );
  };
  const close = () => {
    modal.hidden = true;
    onClose?.();
  };
  $("g-prev").onclick = () => { if (i > 0) { i--; show(); } };
  $("g-next").onclick = () => { if (i < GUIDE_STEPS.length - 1) { i++; show(); } else close(); };
  modal.querySelector("[data-close]").onclick = close;
  return function open() {
    i = 0;
    show();
    modal.hidden = false;
    $("g-next").focus();
  };
}

/**
 * One-time tips: show(key, anchor) displays the bubble next to `anchor`
 * unless that tip was already acknowledged (`seen` is persisted by caller).
 */
export function setupTips(doc, { seen, onSeen }) {
  const box = doc.getElementById("tip");
  const text = doc.getElementById("tip-text");
  let current = null;
  doc.getElementById("tip-ok").onclick = () => {
    box.hidden = true;
    if (current) onSeen(current);
    current = null;
  };
  return function show(key, anchor) {
    if (seen.has(key) || current || !anchor || !TIPS[key]) return false;
    if (doc.querySelector(".modal:not([hidden])")) return false; // never over a dialog
    current = key;
    text.textContent = TIPS[key];
    box.hidden = false;
    const r = anchor.getBoundingClientRect();
    const bw = box.offsetWidth;
    const bh = box.offsetHeight;
    const vw = doc.documentElement.clientWidth;
    let left = Math.min(Math.max(10, r.left + r.width / 2 - bw / 2), vw - bw - 10);
    const above = r.top - bh - 16 > 10;
    box.classList.toggle("above", above);
    box.classList.toggle("below", !above);
    box.style.left = `${left}px`;
    box.style.top = `${above ? r.top - bh - 16 : r.bottom + 16}px`;
    box.style.setProperty("--arrow-x", `${Math.min(bw - 30, Math.max(12, r.left + r.width / 2 - left - 9))}px`);
    return true;
  };
}
