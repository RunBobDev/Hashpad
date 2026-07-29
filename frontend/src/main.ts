import './styles/app.css';

import logo from './assets/images/logo-universal.png';

// Placeholder shell only: proves the Wails <-> frontend wiring survived the
// app -> internal/app package move (SPEC §4). Real editor UI arrives in later
// checkpoints; the template's Greet demo is not carried over (see task brief).
document.querySelector('#app')!.innerHTML = `
    <img id="logo" class="logo">
`;
(document.getElementById('logo') as HTMLImageElement).src = logo;
