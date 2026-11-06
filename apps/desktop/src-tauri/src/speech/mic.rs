//! The microphone behind [`MicSource`]. `CpalMic` records on a dedicated
//! thread, because a cpal stream is not `Send`; tests use `FakeMic`.

use std::sync::mpsc;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat};

use super::pcm::downmix;
use super::permission::{self, MicPermission};

/// Receives mono samples at the device rate, on the audio thread.
pub type Sink = Box<dyn FnMut(&[f32]) + Send>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicError {
    NoDevice,
    Denied,
    Failed,
}

impl MicError {
    pub fn code(self) -> &'static str {
        match self {
            MicError::NoDevice => "speech_no_mic",
            MicError::Denied => "speech_mic_denied",
            MicError::Failed => "speech_mic_failed",
        }
    }
}

/// A recording in progress; dropping it stops the device.
pub struct Running {
    pub rate: u32,
    /// Held only for its `Drop`, which stops the device.
    #[allow(dead_code)]
    pub guard: Box<dyn Send>,
}

pub trait MicSource {
    /// The input device names; the first flag marks the default.
    fn devices(&self) -> Result<Vec<(String, bool)>, MicError>;
    /// Starts `name`, or the default device for `None`.
    fn open(&self, name: Option<&str>, sink: Sink) -> Result<Running, MicError>;
}

/// The real microphone.
pub struct CpalMic;

/// How long the capture thread gets to open the device.
const OPEN_WITHIN: Duration = Duration::from_secs(5);

impl MicSource for CpalMic {
    fn devices(&self) -> Result<Vec<(String, bool)>, MicError> {
        let host = cpal::default_host();
        let default = host.default_input_device().and_then(|d| d.name().ok());
        let devices = host.input_devices().map_err(|_| MicError::Failed)?;
        let mut out: Vec<(String, bool)> = Vec::new();
        for device in devices {
            let Ok(name) = device.name() else { continue };
            if out.iter().any(|(n, _)| *n == name) {
                continue;
            }
            let is_default = default.as_deref() == Some(name.as_str());
            out.push((name, is_default));
        }
        Ok(out)
    }

    fn open(&self, name: Option<&str>, sink: Sink) -> Result<Running, MicError> {
        if permission::status() == MicPermission::Denied {
            return Err(MicError::Denied);
        }
        let name = name.map(str::to_owned);
        let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, MicError>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let thread = std::thread::Builder::new()
            .name("speech-capture".to_owned())
            .spawn(move || match build(name.as_deref(), sink) {
                Ok((stream, rate)) => {
                    let _ = ready_tx.send(Ok(rate));
                    // Runs until the guard drops the sender.
                    let _ = stop_rx.recv();
                    drop(stream);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            })
            .map_err(|_| MicError::Failed)?;
        let rate = ready_rx
            .recv_timeout(OPEN_WITHIN)
            .map_err(|_| MicError::Failed)??;
        Ok(Running {
            rate,
            guard: Box::new(CaptureThread {
                stop: Some(stop_tx),
                thread: Some(thread),
            }),
        })
    }
}

struct CaptureThread {
    stop: Option<mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for CaptureThread {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn find_device(host: &cpal::Host, name: Option<&str>) -> Option<cpal::Device> {
    match name {
        Some(name) => host
            .input_devices()
            .ok()?
            .find(|d| d.name().ok().as_deref() == Some(name)),
        None => host.default_input_device(),
    }
}

fn build(name: Option<&str>, sink: Sink) -> Result<(cpal::Stream, u32), MicError> {
    let host = cpal::default_host();
    let device = find_device(&host, name).ok_or(MicError::NoDevice)?;
    let config = device.default_input_config().map_err(|e| match e {
        cpal::DefaultStreamConfigError::DeviceNotAvailable => MicError::NoDevice,
        _ => MicError::Failed,
    })?;
    let channels = config.channels();
    let rate = config.sample_rate().0;
    let format = config.sample_format();
    let config: cpal::StreamConfig = config.into();
    let stream = match format {
        SampleFormat::F32 => input::<f32>(&device, &config, channels, sink),
        SampleFormat::I16 => input::<i16>(&device, &config, channels, sink),
        SampleFormat::U16 => input::<u16>(&device, &config, channels, sink),
        _ => return Err(MicError::Failed),
    }
    .map_err(|e| match e {
        cpal::BuildStreamError::DeviceNotAvailable => MicError::NoDevice,
        _ => MicError::Failed,
    })?;
    stream.play().map_err(|e| match e {
        cpal::PlayStreamError::DeviceNotAvailable => MicError::NoDevice,
        _ => MicError::Failed,
    })?;
    Ok((stream, rate))
}

fn input<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: u16,
    mut sink: Sink,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: cpal::SizedSample,
    f32: FromSample<T>,
{
    device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            let floats: Vec<f32> = data.iter().map(|s| s.to_sample::<f32>()).collect();
            sink(&downmix(&floats, channels));
        },
        |e| crate::applog::warn("speech", &format!("input stream: {e}")),
        None,
    )
}

#[cfg(test)]
pub mod fake {
    use std::sync::{Arc, Mutex};

    use super::*;

    /// What `FakeMic::open` does.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Behaviour {
        Ok,
        NoDevice,
        Denied,
        BuildError,
    }

    /// A microphone fed by the test through [`FakeMic::feed`].
    pub struct FakeMic {
        pub behaviour: Behaviour,
        pub rate: u32,
        pub names: Vec<String>,
        pub opened: Mutex<Vec<Option<String>>>,
        sink: Arc<Mutex<Option<Sink>>>,
    }

    impl FakeMic {
        pub fn new(behaviour: Behaviour) -> Self {
            Self {
                behaviour,
                rate: 16_000,
                names: vec!["Built-in".to_owned()],
                opened: Mutex::new(Vec::new()),
                sink: Arc::new(Mutex::new(None)),
            }
        }

        /// Hands `samples` to the running recording, if any.
        pub fn feed(&self, samples: &[f32]) {
            if let Some(sink) = self.sink.lock().unwrap().as_mut() {
                sink(samples);
            }
        }

        /// Feeds `samples` in 10 ms chunks, as a device would.
        pub fn feed_chunks(&self, samples: &[f32]) {
            for chunk in samples.chunks((self.rate / 100) as usize) {
                self.feed(chunk);
            }
        }

        pub fn open_count(&self) -> usize {
            self.opened.lock().unwrap().len()
        }
    }

    struct Guard(Arc<Mutex<Option<Sink>>>);

    impl Drop for Guard {
        fn drop(&mut self) {
            *self.0.lock().unwrap() = None;
        }
    }

    impl MicSource for FakeMic {
        fn devices(&self) -> Result<Vec<(String, bool)>, MicError> {
            Ok(self
                .names
                .iter()
                .enumerate()
                .map(|(i, n)| (n.clone(), i == 0))
                .collect())
        }

        fn open(&self, name: Option<&str>, sink: Sink) -> Result<Running, MicError> {
            self.opened.lock().unwrap().push(name.map(str::to_owned));
            match self.behaviour {
                Behaviour::Ok => {}
                Behaviour::NoDevice => return Err(MicError::NoDevice),
                Behaviour::Denied => return Err(MicError::Denied),
                Behaviour::BuildError => return Err(MicError::Failed),
            }
            *self.sink.lock().unwrap() = Some(sink);
            Ok(Running {
                rate: self.rate,
                guard: Box::new(Guard(self.sink.clone())),
            })
        }
    }
}
