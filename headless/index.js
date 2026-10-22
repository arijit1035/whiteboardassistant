// headless/index.js
//
// Background (headless) iframe for the Voice Assistant Miro app.
//
// Responsibilities:
//   1. Initialize the Miro Web SDK.
//   2. React to the app toolbar icon click (icon:click is dispatched ONLY to the
//      headless iframe — per Miro docs).
//   3. Open the assistant panel, passing boardId/boardName so the panel can
//      create sticky notes, tags, and vote icons on the board.

(async () => {
  const status = document.getElementById('status');

  // The `miro` global is provided by https://miro.com/app/static/sdk/v2/miro.js
  await miro.initialize();
  status.textContent = 'Miro SDK ready. Click the app toolbar icon to open the assistant panel.';

  const board = await miro.board.get();
  status.textContent = `Board: ${board.name} (${board.id})`;

  // icon:click is dispatched ONLY to the headless/main iframe.
  // Use it to surface the assistant panel from the board toolbar.
  miro.board.ui.on('icon:click', async () => {
    try {
      const { waitForClose } = await miro.board.ui.openPanel({
        url: '../panel/index.html',
        height: 600,
        data: { boardId: board.id, boardName: board.name },
      });
      const result = await waitForClose();
      status.textContent = `Panel closed (result: ${JSON.stringify(result)})`;
    } catch (err) {
      console.error('Failed to open panel:', err);
      status.textContent = 'Error opening panel. Check console.';
    }
  });
})();
