/**
 * Generate notification sound files for Layer4 Chat
 * Creates different beep sounds for various notification types
 */

const fs = require('fs');
const path = require('path');

// Simple tone generator for creating WAV files
function generateTone(frequency, duration, sampleRate = 44100, volume = 0.3) {
  const samples = Math.floor(duration * sampleRate);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  
  // WAV header
  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };
  
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples * 2, true);
  
  // Generate sine wave
  for (let i = 0; i < samples; i++) {
    const sample = Math.sin(2 * Math.PI * frequency * i / sampleRate) * volume * 32767;
    view.setInt16(44 + i * 2, sample, true);
  }
  
  return buffer;
}

// Generate different notification sounds
const sounds = [
  {
    name: 'message_notification.wav',
    frequency: 800,
    duration: 0.3,
    volume: 0.4
  },
  {
    name: 'message_gentle.wav',
    frequency: 600,
    duration: 0.2,
    volume: 0.3
  },
  {
    name: 'message_loud.wav',
    frequency: 1000,
    duration: 0.4,
    volume: 0.6
  },
  {
    name: 'dm_notification.wav',
    frequency: 700,
    duration: 0.25,
    volume: 0.5
  },
  {
    name: 'mention_notification.wav',
    frequency: 900,
    duration: 0.35,
    volume: 0.6
  }
];

// Ensure web_sounds directory exists in frontend public folder
const webSoundsDir = path.join(__dirname, '../../frontend/public/web_sounds');
if (!fs.existsSync(webSoundsDir)) {
  fs.mkdirSync(webSoundsDir, { recursive: true });
}

// Generate each sound file
sounds.forEach(sound => {
  const buffer = generateTone(sound.frequency, sound.duration, 44100, sound.volume);
  const filePath = path.join(webSoundsDir, sound.name);
  
  fs.writeFileSync(filePath, Buffer.from(buffer));
  console.log(`✅ Generated: ${sound.name}`);
});

console.log('🎵 All notification sounds generated successfully!');
