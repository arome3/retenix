// Renders above the content of every (app) screen. Doc 14 fills it with the
// amber inheritance-countdown banner (C8) by portaling into this element:
//
//   createPortal(<CountdownBanner …/>,
//     document.getElementById(COUNTDOWN_BANNER_SLOT_ID))
//
// Empty by design in this module — the slot is the contract, not the banner.
export const COUNTDOWN_BANNER_SLOT_ID = "countdown-banner-slot";

export function CountdownBannerSlot() {
  return <div id={COUNTDOWN_BANNER_SLOT_ID} data-slot="countdown-banner" />;
}
