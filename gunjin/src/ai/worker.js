self.onmessage = async (event) => {
  const { chooseAiMoveFromView } = await import("./shared.js");
  const { view, difficulty, requestId, debug } = event.data;
  const move = chooseAiMoveFromView(view, difficulty, { debug });
  self.postMessage({ move, requestId });
};
