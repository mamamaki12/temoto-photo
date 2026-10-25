# faceai.js の ALIGN_TPL を作る: FFHQ と同じ並べ方（facexlib の RetinaFace 5 点）で 512 に切り出した顔の上で、MediaPipe の点の中央値をとる
# 使い方: python align_template.py face_landmarker.task 切り出した顔のフォルダー（*.png）
import sys, glob, numpy as np, cv2, mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions
IDX = [33, 133, 362, 263, 468, 473, 1, 4, 5, 6, 168, 61, 291, 0, 17, 13, 14, 70, 300, 105, 334]
lm = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path=sys.argv[1]), num_faces=6))
pts = []
for f in sorted(glob.glob(sys.argv[2] + '/*.png')):
    im = cv2.imread(f)[:, :, ::-1]; r = lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(im)))
    if not r.face_landmarks: continue
    fs = [np.array([[p.x * 512, p.y * 512] for p in f]) for f in r.face_landmarks]
    pts.append(min(fs, key=lambda p: np.linalg.norm(p.mean(0) - 256))[IDX])
print(len(pts), np.round(np.median(np.array(pts), 0), 1).flatten().tolist())
