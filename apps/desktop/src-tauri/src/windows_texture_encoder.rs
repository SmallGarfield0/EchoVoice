use crate::native_screen_share::letterbox_rect;
use ev_media::ScreenShareVideoProfile;
use std::mem::ManuallyDrop;
use windows::core::{Interface, Result};
use windows::Win32::Foundation::{BOOL, E_FAIL, RECT};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Media::MediaFoundation::*;

/// The allocator recycles an NV12 surface only after the MFT releases its sample.
pub(super) struct TextureEncoderInput {
    video: ID3D11VideoDevice,
    context: ID3D11VideoContext1,
    allocator: IMFVideoSampleAllocatorEx,
    _manager: IMFDXGIDeviceManager,
    processor: Option<(
        u32,
        u32,
        ID3D11VideoProcessorEnumerator,
        ID3D11VideoProcessor,
    )>,
    width: u32,
    height: u32,
    fps: u32,
}

impl TextureEncoderInput {
    pub(super) unsafe fn new(
        device: &ID3D11Device,
        mft: &IMFTransform,
        profile: &ScreenShareVideoProfile,
        media_type: &IMFMediaType,
    ) -> Result<Self> {
        let attrs = mft.GetAttributes()?;
        if attrs.GetUINT32(&MF_SA_D3D11_AWARE)? == 0 {
            return Err(windows::core::Error::new(
                E_FAIL,
                "MFT cannot accept D3D11 surfaces",
            ));
        }
        let video = device.cast()?;
        let context = device.GetImmediateContext()?.cast()?;
        let mut token = 0;
        let mut manager = None;
        MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
        let manager = manager.ok_or(E_FAIL)?;
        manager.ResetDevice(device, token)?;
        let mut allocator = None::<IMFVideoSampleAllocatorEx>;
        MFCreateVideoSampleAllocatorEx(
            &IMFVideoSampleAllocatorEx::IID,
            &mut allocator as *mut _ as _,
        )?;
        let allocator = allocator.ok_or(E_FAIL)?;
        allocator.SetDirectXManager(&manager)?;
        let mut allocation_attrs = None;
        MFCreateAttributes(&mut allocation_attrs, 2)?;
        let allocation_attrs = allocation_attrs.ok_or(E_FAIL)?;
        allocation_attrs.SetUINT32(&MF_SA_D3D11_BINDFLAGS, D3D11_BIND_RENDER_TARGET.0 as u32)?;
        allocation_attrs.SetUINT32(&MF_SA_BUFFERS_PER_SAMPLE, 1)?;
        allocator.InitializeSampleAllocatorEx(2, 6, &allocation_attrs, media_type)?;
        mft.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)?;
        Ok(Self {
            video,
            context,
            allocator,
            _manager: manager,
            processor: None,
            width: profile.output_size.width(),
            height: profile.output_size.height(),
            fps: profile.frame_rate.fps(),
        })
    }

    pub(super) unsafe fn convert(
        &mut self,
        source: &ID3D11Texture2D,
        w: u32,
        h: u32,
    ) -> Result<IMFSample> {
        if self
            .processor
            .as_ref()
            .is_none_or(|(old_w, old_h, _, _)| (*old_w, *old_h) != (w, h))
        {
            let rate = DXGI_RATIONAL {
                Numerator: self.fps,
                Denominator: 1,
            };
            let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: rate,
                InputWidth: w,
                InputHeight: h,
                OutputFrameRate: rate,
                OutputWidth: self.width,
                OutputHeight: self.height,
                Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
            };
            let enumerator = self.video.CreateVideoProcessorEnumerator(&desc)?;
            let processor = self.video.CreateVideoProcessor(&enumerator, 0)?;
            self.context
                .VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            self.context.VideoProcessorSetStreamFrameFormat(
                &processor,
                0,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            );
            self.context.VideoProcessorSetStreamColorSpace1(
                &processor,
                0,
                DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
            );
            self.context.VideoProcessorSetOutputColorSpace1(
                &processor,
                DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709,
            );
            let (fit_w, fit_h, x, y) = letterbox_rect(
                self.width as usize,
                self.height as usize,
                w as usize,
                h as usize,
            );
            self.context.VideoProcessorSetStreamDestRect(
                &processor,
                0,
                true,
                Some(&RECT {
                    left: x as i32,
                    top: y as i32,
                    right: (x + fit_w) as i32,
                    bottom: (y + fit_h) as i32,
                }),
            );
            self.context.VideoProcessorSetOutputBackgroundColor(
                &processor,
                false,
                &D3D11_VIDEO_COLOR::default(),
            );
            self.processor = Some((w, h, enumerator, processor));
        }
        let (_, _, enumerator, processor) = self.processor.as_ref().unwrap();
        let sample = self.allocator.AllocateSample()?;
        let buffer: IMFDXGIBuffer = sample.GetBufferByIndex(0)?.cast()?;
        let mut target = None::<ID3D11Texture2D>;
        buffer.GetResource(&ID3D11Texture2D::IID, &mut target as *mut _ as _)?;
        let target = target.ok_or(E_FAIL)?;
        let mut target_desc = D3D11_TEXTURE2D_DESC::default();
        target.GetDesc(&mut target_desc);
        let subresource = buffer.GetSubresourceIndex()?;
        let output_desc = if target_desc.ArraySize > 1 {
            D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2DARRAY,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                    Texture2DArray: D3D11_TEX2D_ARRAY_VPOV {
                        MipSlice: subresource % target_desc.MipLevels,
                        FirstArraySlice: subresource / target_desc.MipLevels,
                        ArraySize: 1,
                    },
                },
            }
        } else {
            D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                ..Default::default()
            }
        };
        let mut output = None;
        self.video.CreateVideoProcessorOutputView(
            &target,
            enumerator,
            &output_desc,
            Some(&mut output),
        )?;
        let output = output.ok_or(E_FAIL)?;
        let mut input = None;
        self.video.CreateVideoProcessorInputView(
            source,
            enumerator,
            &D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                ..Default::default()
            },
            Some(&mut input),
        )?;
        let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: BOOL(1),
            pInputSurface: ManuallyDrop::new(input),
            ..Default::default()
        };
        let result =
            self.context
                .VideoProcessorBlt(processor, &output, 0, std::slice::from_ref(&stream));
        ManuallyDrop::drop(&mut stream.pInputSurface);
        result?;
        Ok(sample)
    }
}
