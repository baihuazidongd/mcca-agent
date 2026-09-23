package com.mcca.mobile.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import com.mcca.mobile.data.Images
import com.mcca.mobile.store.Img
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.InputStream

/** 图片选择/拍照 → 压缩成 JPEG base64（长边 ≤1600，单张 ≤2MB）。 */
object ImagePicker {

    suspend fun encode(context: Context, uri: Uri, name: String = ""): Img? = withContext(Dispatchers.IO) {
        try {
            val bytes = context.contentResolver.openInputStream(uri)?.use(InputStream::readBytes) ?: return@withContext null
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            var sample = 1
            val maxSide = maxOf(bounds.outWidth, bounds.outHeight)
            while (maxSide / sample > 1600) sample *= 2
            val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
                ?: return@withContext null
            val out = java.io.ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, 82, out)
            val data = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
            Img.inline("image/jpeg", data, name)
        } catch (_: Throwable) {
            null
        }
    }

    fun cameraUri(context: Context): Uri {
        val dir = File(context.cacheDir, "camera").apply { mkdirs() }
        val file = File(dir, "shot-${System.currentTimeMillis()}.jpg")
        return FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
    }
}

class ImageDraft {
    val images = mutableStateListOf<Img>()
    var busy by mutableStateOf(false)
    fun clear() = images.clear()
    fun remove(img: Img) = images.remove(img)
    fun addAll(list: List<Img>) {
        for (img in list) if (images.size < 4) images.add(img)
    }
}

@Composable
fun rememberImageDraft(): ImageDraft = remember { ImageDraft() }

class ImagePickActions(val pickFromGallery: () -> Unit, val takePhoto: () -> Unit)

/** 相册多选 + 拍照两个入口，统一进草稿箱。 */
@Composable
fun rememberImagePickActions(draft: ImageDraft, onError: (String) -> Unit): ImagePickActions {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var cameraUri by remember { mutableStateOf<Uri?>(null) }

    val gallery = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(4)) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            draft.busy = true
            val encoded = uris.mapNotNull { ImagePicker.encode(context, it) }
            draft.addAll(encoded)
            draft.busy = false
            if (encoded.isEmpty()) onError("图片读取失败")
        }
    }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val uri = cameraUri ?: return@rememberLauncherForActivityResult
        if (!ok) return@rememberLauncherForActivityResult
        scope.launch {
            draft.busy = true
            val img = ImagePicker.encode(context, uri, "camera.jpg")
            if (img != null) draft.addAll(listOf(img)) else onError("照片读取失败")
            draft.busy = false
        }
    }
    return remember {
        ImagePickActions(
            pickFromGallery = { gallery.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            takePhoto = {
                val uri = ImagePicker.cameraUri(context)
                cameraUri = uri
                camera.launch(uri)
            },
        )
    }
}

@Composable
fun ImageThumb(
    agent: String,
    sessionId: String,
    img: Img,
    modifier: Modifier = Modifier,
    size: Dp? = null,
    onClick: () -> Unit = {},
) {
    val bitmap by produceState<Bitmap?>(initialValue = Images.cached(img), img.key) {
        value = Images.cached(img) ?: Images.load(agent, sessionId, img)
    }
    val base = if (size != null) modifier.size(size) else modifier
    Box(
        base
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .clickable { if (bitmap != null) onClick() },
        contentAlignment = Alignment.Center,
    ) {
        val bmp = bitmap
        if (bmp != null) {
            Image(
                bitmap = bmp.asImageBitmap(),
                contentDescription = img.name.ifEmpty { "图片" },
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            if (Images.failed(img)) {
                Text("图片不可用", fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                Text("加载中…", fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** 气泡里的图片组：1 张大图 / 2-3 张排一行 / 更多两列。 */
@Composable
fun ImageGrid(
    agent: String,
    sessionId: String,
    images: List<Img>,
    onOpen: (Int) -> Unit,
) {
    if (images.isEmpty()) return
    val show = images.take(4)
    val widthDp = LocalConfiguration.current.screenWidthDp
    val singleWidth = (widthDp * 0.68f).dp.coerceIn(200.dp, 420.dp)
    val cell = ((singleWidth - 4.dp) / 2).coerceIn(96.dp, 200.dp)
    val singleHeight = (singleWidth * 0.78f).coerceAtMost(420.dp)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (show.size == 1) {
            ImageThumb(
                agent, sessionId, show[0],
                modifier = Modifier.width(singleWidth).heightIn(max = singleHeight),
                onClick = { onOpen(0) },
            )
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                show.take(2).forEachIndexed { i, img ->
                    ImageThumb(agent, sessionId, img, modifier = Modifier.size(cell), onClick = { onOpen(i) })
                }
            }
            if (show.size > 2) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    show.drop(2).forEachIndexed { i, img ->
                        ImageThumb(agent, sessionId, img, modifier = Modifier.size(cell), onClick = { onOpen(i + 2) })
                    }
                }
            }
        }
    }
}

/** 全屏查看：左右翻页、双指缩放、双击复位、保存到相册。 */
@Composable
fun ImageViewer(
    agent: String,
    sessionId: String,
    images: List<Img>,
    startIndex: Int,
    onClose: () -> Unit,
    onToast: (String) -> Unit,
) {
    if (images.isEmpty()) return
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val pager = rememberPagerState(initialPage = startIndex.coerceIn(0, images.lastIndex)) { images.size }

    Box(Modifier.fillMaxSize().background(Color(0xFF05070A))) {
        HorizontalPager(state = pager, modifier = Modifier.fillMaxSize()) { page ->
            ZoomableImage(agent, sessionId, images[page])
        }
        Row(
            Modifier
                .align(Alignment.TopEnd)
                .padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(
                Modifier
                    .size(38.dp)
                    .clip(CircleShape)
                    .background(Color(0x66000000))
                    .clickable {
                        val img = images[pager.currentPage]
                        scope.launch {
                            val bmp = Images.cached(img) ?: Images.load(agent, sessionId, img)
                            if (bmp == null) {
                                onToast("图片还没加载好")
                                return@launch
                            }
                            val where = Images.saveToGallery(context, bmp)
                            onToast(if (where != null) "已保存到 $where" else "保存失败")
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text("保存", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Medium)
            }
            Box(
                Modifier
                    .size(38.dp)
                    .clip(CircleShape)
                    .background(Color(0x66000000))
                    .clickable(onClick = onClose),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Default.Close, contentDescription = "关闭", tint = Color.White, modifier = Modifier.size(18.dp))
            }
        }
        if (images.size > 1) {
            Text(
                "${pager.currentPage + 1} / ${images.size}",
                color = Color.White.copy(alpha = 0.8f),
                fontSize = 12.sp,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 24.dp),
            )
        }
    }
}

@Composable
private fun ZoomableImage(agent: String, sessionId: String, img: Img) {
    val bitmap by produceState<Bitmap?>(initialValue = Images.cached(img), img.key) {
        value = Images.cached(img) ?: Images.load(agent, sessionId, img)
    }
    var scale by remember { mutableStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    val bmp = bitmap
    Box(
        Modifier
            .fillMaxSize()
            .pointerInput(img.key) {
                detectTransformGestures { _, pan, zoom, _ ->
                    scale = (scale * zoom).coerceIn(1f, 6f)
                    offset = if (scale <= 1.01f) Offset.Zero else offset + pan
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        if (bmp == null) {
            Text(if (Images.failed(img)) "图片不可用" else "加载中…", color = Color.White.copy(alpha = 0.7f), fontSize = 13.sp)
        } else {
            Image(
                bitmap = bmp.asImageBitmap(),
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxSize()
                    .graphicsLayer(
                        scaleX = scale,
                        scaleY = scale,
                        translationX = offset.x,
                        translationY = offset.y,
                    ),
            )
        }
    }
}
