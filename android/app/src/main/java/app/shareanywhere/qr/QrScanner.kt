package app.shareanywhere.qr

import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Camera viewfinder that decodes QR codes (RX-1 `receive`, scan tab). CameraX ImageAnalysis frames are decoded with
 * ZXing on a background thread; [onResult] runs on the main thread for each decoded text until [active] is false.
 * The camera is released when this leaves composition. Needs the CAMERA permission (asked just in time).
 */
@Composable
fun QrScanner(active: Boolean, torch: Boolean, onResult: (String) -> Unit, onUnavailable: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val result by rememberUpdatedState(onResult)
    val unavailable by rememberUpdatedState(onUnavailable)
    val enabled = remember { AtomicBoolean(active) }
    enabled.set(active)
    val previewView = remember { PreviewView(context).apply { implementationMode = PreviewView.ImplementationMode.COMPATIBLE } }
    val holder = remember { arrayOfNulls<androidx.camera.core.Camera>(1) }

    DisposableEffect(lifecycleOwner) {
        val executor = Executors.newSingleThreadExecutor()
        val main = ContextCompat.getMainExecutor(context)
        val future = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        future.addListener({
            try {
                val p = future.get()
                provider = p
                val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
                val analysis =
                    ImageAnalysis
                        .Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                analysis.setAnalyzer(executor) { image ->
                    val text = if (enabled.get()) decode(image) else null
                    image.close()
                    if (text != null) main.execute { if (enabled.get()) result(text) }
                }
                p.unbindAll()
                holder[0] = p.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            } catch (_: Exception) {
                // No back camera (some emulators, Chromebooks) or the camera is in use: offer code entry instead.
                unavailable()
            }
        }, main)
        onDispose {
            provider?.unbindAll()
            holder[0] = null
            executor.shutdown()
        }
    }
    DisposableEffect(torch, holder[0]) {
        holder[0]?.let { cam -> if (cam.cameraInfo.hasFlashUnit()) cam.cameraControl.enableTorch(torch) }
        onDispose { }
    }
    AndroidView(factory = { previewView }, modifier = modifier)
}

private fun decode(image: ImageProxy): String? {
    val plane = image.planes.firstOrNull() ?: return null
    val buffer = plane.buffer
    val bytes = ByteArray(buffer.remaining())
    buffer.get(bytes)
    return Qr.decode(bytes, image.width, image.height, plane.rowStride)
}
