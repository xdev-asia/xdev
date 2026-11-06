//! The audio pipeline: mono downmix, linear resample to 16 kHz, 16-bit PCM
//! and a WAV file. Pure functions; no audio device types.

/// The rate of the uploaded clip.
pub const SAMPLE_RATE: u32 = 16_000;
/// A shorter clip is not uploaded.
pub const MIN_AUDIO_MS: u64 = 500;
/// Capture stops by itself at this length (about 3.84 MB of WAV).
pub const MAX_AUDIO_MS: u64 = 120_000;

/// Averages interleaved frames of `channels` samples into one channel.
pub fn downmix(interleaved: &[f32], channels: u16) -> Vec<f32> {
    let channels = usize::from(channels.max(1));
    if channels == 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Linear resample of mono `input` at `from_rate` to [`SAMPLE_RATE`].
pub fn resample_linear(input: &[f32], from_rate: u32) -> Vec<f32> {
    if from_rate == SAMPLE_RATE || from_rate == 0 || input.is_empty() {
        return input.to_vec();
    }
    let out_len = (input.len() as u64 * u64::from(SAMPLE_RATE) / u64::from(from_rate)) as usize;
    let step = f64::from(from_rate) / f64::from(SAMPLE_RATE);
    let last = input.len() - 1;
    (0..out_len)
        .map(|i| {
            let pos = i as f64 * step;
            let at = (pos as usize).min(last);
            let next = (at + 1).min(last);
            let frac = (pos - at as f64) as f32;
            input[at] + (input[next] - input[at]) * frac
        })
        .collect()
}

/// Float samples in -1..1 to 16-bit PCM, clamped.
pub fn to_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|s| {
            let v = (s * 32768.0).round();
            v.clamp(f32::from(i16::MIN), f32::from(i16::MAX)) as i16
        })
        .collect()
}

/// A mono 16 kHz 16-bit WAV file with the 44-byte header.
pub fn wav_bytes(samples: &[i16]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // channels
    out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// Loudness 0..100 for the indicator: the square root of the RMS, so speech
/// moves the meter while a full-scale signal reads 100.
pub fn level(samples: &[f32]) -> u8 {
    if samples.is_empty() {
        return 0;
    }
    let mean = samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32;
    (mean.sqrt().sqrt() * 100.0).round().clamp(0.0, 100.0) as u8
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipError {
    TooShort,
    /// Every sample is zero: the OS handed out silence (Windows privacy).
    Silent,
}

/// The mono recording at the device rate, capped at [`MAX_AUDIO_MS`].
#[derive(Debug, Clone)]
pub struct Clip {
    rate: u32,
    samples: Vec<f32>,
    capped: bool,
}

impl Clip {
    pub fn new(rate: u32) -> Self {
        Self {
            rate: rate.max(1),
            samples: Vec::new(),
            capped: false,
        }
    }

    fn max_samples(&self) -> usize {
        (u64::from(self.rate) * MAX_AUDIO_MS / 1000) as usize
    }

    /// Appends mono samples; returns true once the cap is reached.
    pub fn push(&mut self, mono: &[f32]) -> bool {
        let room = self.max_samples().saturating_sub(self.samples.len());
        let take = room.min(mono.len());
        self.samples.extend_from_slice(&mono[..take]);
        if take < mono.len() || self.samples.len() >= self.max_samples() {
            self.capped = true;
        }
        self.capped
    }

    pub fn capped(&self) -> bool {
        self.capped
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.samples.len() as u64 * 1000 / u64::from(self.rate)
    }

    pub fn check(&self) -> Result<(), ClipError> {
        if (self.samples.len() as u64) * 1000 < MIN_AUDIO_MS * u64::from(self.rate) {
            return Err(ClipError::TooShort);
        }
        if self.samples.iter().all(|s| s.abs() < 1.0 / 32768.0) {
            return Err(ClipError::Silent);
        }
        Ok(())
    }

    /// The upload: 16 kHz mono WAV.
    pub fn wav(&self) -> Vec<u8> {
        wav_bytes(&to_i16(&resample_linear(&self.samples, self.rate)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u16_at(b: &[u8], at: usize) -> u16 {
        u16::from_le_bytes([b[at], b[at + 1]])
    }

    fn u32_at(b: &[u8], at: usize) -> u32 {
        u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
    }

    #[test]
    fn downmix_averages_frames() {
        assert_eq!(downmix(&[1.0, -1.0, 0.5, 0.5], 2), vec![0.0, 0.5]);
        assert_eq!(downmix(&[0.25, 0.5], 1), vec![0.25, 0.5]);
    }

    #[test]
    fn resample_lengths() {
        assert_eq!(resample_linear(&vec![0.1; 48_000], 48_000).len(), 16_000);
        let same = vec![0.3; 1234];
        assert_eq!(resample_linear(&same, 16_000), same);
        let n = 44_100usize;
        let want = n * 16_000 / 44_100;
        let got = resample_linear(&vec![0.2; n], 44_100).len();
        assert!(got.abs_diff(want) <= 1, "{got} vs {want}");
    }

    #[test]
    fn resample_interpolates() {
        let ramp: Vec<f32> = (0..48).map(|i| i as f32).collect();
        let out = resample_linear(&ramp, 48_000);
        assert_eq!(out, (0..16).map(|i| (i * 3) as f32).collect::<Vec<_>>());
    }

    #[test]
    fn to_i16_clamps() {
        assert_eq!(to_i16(&[1.5, -1.5, 0.0]), vec![32767, -32768, 0]);
    }

    #[test]
    fn wav_header() {
        let wav = wav_bytes(&[0i16; 16_000]);
        assert_eq!(wav.len(), 44 + 32_000);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(u32_at(&wav, 4), 36 + 32_000);
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u16_at(&wav, 20), 1);
        assert_eq!(u16_at(&wav, 22), 1);
        assert_eq!(u32_at(&wav, 24), 16_000);
        assert_eq!(u16_at(&wav, 34), 16);
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32_at(&wav, 40), 32_000);
    }

    #[test]
    fn level_range() {
        assert_eq!(level(&[0.0; 160]), 0);
        let square: Vec<f32> = (0..160)
            .map(|i| if i % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        assert_eq!(level(&square), 100);
        assert_eq!(level(&[]), 0);
    }

    #[test]
    fn clip_check() {
        let mut short = Clip::new(16_000);
        short.push(&vec![0.5; 7_999]);
        assert_eq!(short.check(), Err(ClipError::TooShort));
        let mut silent = Clip::new(16_000);
        silent.push(&vec![0.0; 16_001]);
        assert_eq!(silent.check(), Err(ClipError::Silent));
        let mut ok = Clip::new(16_000);
        ok.push(&vec![0.5; 8_000]);
        assert_eq!(ok.check(), Ok(()));
        assert_eq!(ok.elapsed_ms(), 500);
    }

    #[test]
    fn clip_push_stops_at_the_cap() {
        let mut clip = Clip::new(1_000);
        let cap = (MAX_AUDIO_MS) as usize; // 1 sample per ms at 1 kHz
        assert!(!clip.push(&vec![0.1; cap - 1]));
        assert!(!clip.capped());
        assert!(clip.push(&[0.1; 10]));
        assert!(clip.capped());
        assert_eq!(clip.elapsed_ms(), MAX_AUDIO_MS);
        assert!(clip.push(&[0.1]));
        assert_eq!(clip.elapsed_ms(), MAX_AUDIO_MS);
    }

    #[test]
    fn clip_wav_is_16k() {
        let mut clip = Clip::new(48_000);
        clip.push(&vec![0.5; 48_000]);
        assert_eq!(clip.wav().len(), 44 + 32_000);
    }
}
