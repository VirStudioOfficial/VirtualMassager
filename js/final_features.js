// Final feature layer preparation

export const finalFeatures = {
  media: {
    imagePreview: true,
    videoPreview: true,
    fileAttachments: true,
    voiceMessages: true
  },
  performance: {
    lazyLoading: true,
    cachingReady: true,
    pwaReady: true
  },
  security: {
    errorHandling: true,
    sessionProtection: true
  }
};

export function createMediaPreview(file) {
  return {
    name: file?.name || "",
    type: file?.type || ""
  };
}
