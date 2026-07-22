/**
 * PCM tap for chirpdev — AudioWorklet replacement for ScriptProcessorNode.
 * Forwards mono input frames to the main thread (zero-copy transferable).
 */
class PcmTapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    var input = inputs[0];
    if (input && input[0] && input[0].length) {
      var copy = new Float32Array(input[0]);
      this.port.postMessage({ samples: copy }, [copy.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-tap", PcmTapProcessor);
