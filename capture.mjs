class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blockSize = Math.round(sampleRate * 0.02);
    this.block = new Float32Array(this.blockSize);
    this.used = 0;
  }

  process(inputs) {
    const input = inputs[0][0];
    if (!input) return true;
    for (let index = 0; index < input.length; index++) {
      if (this.used === 0) this.timestamp = (currentFrame + index) / sampleRate;
      this.block[this.used++] = input[index];
      if (this.used === this.blockSize) {
        this.port.postMessage({ samples: this.block, timestamp: this.timestamp }, [this.block.buffer]);
        this.block = new Float32Array(this.blockSize);
        this.used = 0;
      }
    }
    return true;
  }
}

registerProcessor("capture", CaptureProcessor);
