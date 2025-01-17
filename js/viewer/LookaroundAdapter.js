import { ScreenFrustum } from "./ScreenFrustrum.js";
import "./bufferGeometryUtils.js";

const FACES = 6;

function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * @summary Adapter for Look Around panoramas
 * @memberof PSV.adapters
 * @extends PSV.adapters.AbstractAdapter
 */
export class LookaroundAdapter extends PhotoSphereViewer.AbstractAdapter {
  static id = "lookaround";
  static supportsDownload = false;

  /**
   * @param {PSV.Viewer} psv
   */
  constructor(psv) {
    super(psv);

    this.endpoint = this.psv.config.panoData.endpoint;

    this.panorama = this.psv.config.panorama.panorama;
    this.url = this.psv.config.panorama.panorama.url;
    this.previousThetaLength = this.panorama.projection.latitude_size[0];

    this.SPHERE_HORIZONTAL_SEGMENTS = 32;

    this.psv.on(PhotoSphereViewer.CONSTANTS.EVENTS.POSITION_UPDATED, this);
    this.psv.on(PhotoSphereViewer.CONSTANTS.EVENTS.ZOOM_UPDATED, this);
    this.psv.on(PhotoSphereViewer.CONSTANTS.EVENTS.BEFORE_ROTATE, this);

    this.screenFrustum = new ScreenFrustum(this.psv);

    this.dynamicLoadingEnabled = true;
  }

  /**
   * @override
   */
  supportsTransition() {
    return false;
  }

  /**
   * @override
   */
  supportsPreload() {
    return false;
  }

  /**
   * @override
   */
  loadTexture(panoramaMetadata) {
    this.panorama = panoramaMetadata.panorama;
    this.url = panoramaMetadata.url;

    // some trekker panos have longer side faces than regular car footage.
    // if this pano has a different projection from the last one, the mesh needs to be rebuilt.
    this.__recreateMeshIfNecessary();

    // initial load of the pano with a low starting quality.
    // higher resolution faces are loaded dynamically based on zoom level
    // and where the user is looking.
    const promises = [];
    const progress = [0, 0, 0, 0, 0, 0];
    const startZoom = 5;
    for (let i = 0; i < 4; i++) {
      promises.push(this.__loadOneTexture(startZoom, i, progress));
    }
    return Promise.all(promises).then((texture) => ({ panorama: panoramaMetadata, texture }));
  }

  async __loadOneTexture(zoom, faceIdx, progress = null) {
    const faceUrl = `${this.endpoint}${this.url}${zoom}/${faceIdx}/`;
    return await this.psv.textureLoader
      .loadImage(faceUrl, (p) => {
        if (progress) {
          progress[faceIdx] = p;
          this.psv.loader.setProgress(
            PhotoSphereViewer.utils.sum(progress) / 4
          );
        }
      })
      .then((img) => {
        let texture = null;
        texture = PhotoSphereViewer.utils.createTexture(img);
        texture.userData = { zoom: zoom, url: this.url };
        return texture;
      });
  }

  __recreateMeshIfNecessary() {
    const thetaLength = this.panorama.projection.latitude_size[0];
    if (this.previousThetaLength !== thetaLength) {
      this.psv.renderer.scene.remove(this.psv.renderer.meshContainer);

      const mesh = this.psv.adapter.createMesh();
      mesh.userData = { "psvSphere": true };
      this.psv.renderer.mesh = mesh;

      const meshContainer = new THREE.Group();
      meshContainer.add(mesh);
      this.psv.renderer.meshContainer = meshContainer;

      this.psv.renderer.scene.add(meshContainer);
    }
    this.previousThetaLength = thetaLength;
  }

  /**
   * @override
   */
  createMesh(scale = 1) {
    const radius = PhotoSphereViewer.CONSTANTS.SPHERE_RADIUS * scale;

    // fix for trekker panos which use a slightly different projection sometimes.
    // sorry about the weird calculations here; I'm sure there's a more correct way to 
    // derive it from the projection data in the API response, but, well, it's math, so I'm out.
    const normalThetaLength = 1.614429558;
    const normalThetaStart = degToRad(28);
    const dTheta = this.panorama.projection.latitude_size[0] - normalThetaLength;
    const sideFacesThetaStart = normalThetaStart - (dTheta / 2);

    const faces = [
      // radius, widthSegments, heightSegments,
      // phiStart, phiLength, thetaStart, thetaLength
      [
        radius,
        12 * 2,
        this.SPHERE_HORIZONTAL_SEGMENTS,
        degToRad(0-90),
        degToRad(120),
        sideFacesThetaStart,
        this.panorama.projection.latitude_size[0],
      ],
      [
        radius,
        6 * 2,
        this.SPHERE_HORIZONTAL_SEGMENTS,
        degToRad(120-90),
        degToRad(60),
        sideFacesThetaStart,
        this.panorama.projection.latitude_size[1],
      ],
      [
        radius,
        12 * 2,
        this.SPHERE_HORIZONTAL_SEGMENTS,
        degToRad(180-90),
        degToRad(120),
        sideFacesThetaStart,
        this.panorama.projection.latitude_size[2],
      ],
      [
        radius,
        6 * 2,
        this.SPHERE_HORIZONTAL_SEGMENTS,
        degToRad(300-90),
        degToRad(60),
        sideFacesThetaStart,
        this.panorama.projection.latitude_size[3],
      ], /*
      [
        radius,
        36 * 4,
        this.SPHERE_HORIZONTAL_SEGMENTS,
        degToRad(0),
        degToRad(360),
        degToRad(0),
        degToRad(28),
      ],
      [
        radius,
        36 * 4,
        this.SPHERE_HORIZONTAL_SEGMENTS,
        degToRad(0),
        degToRad(360),
        degToRad(28 + 92.5),
        degToRad(59.5),
      ], */
    ];
    const geometries = [];
    this.meshesForFrustum = [];
    for (let i = 0; i < faces.length; i++) {
      const geom = new THREE.SphereGeometry(...faces[i]).scale(-1, 1, 1);
      if (i < 4) {
        this.__setSideUV(geom, i);
      } else {
        this.__setTopBottomUV(geom, i);
      }
      /*if (i == 4) {
        geom.rotateY(????);
      }
      else*/ if (i == 5) {
        geom.rotateY(degToRad(27.5 - 90));
      }
      geometries.push(geom);
      this.meshesForFrustum.push(new THREE.Mesh(geom, []));
    }

    const mergedGeometry = THREE.BufferGeometryUtils.mergeBufferGeometries(geometries, true);
    const mesh = new THREE.Mesh(
      mergedGeometry,
      Array(FACES).fill(new THREE.MeshBasicMaterial())
    );
    this.mesh = mesh;
    return mesh;
  }

  /**
   * Sets the UVs for side faces such that the overlapping portion is removed
   * without having to crop the texture beforehand every time.
   */
  __setSideUV(geom, faceIdx) {
    const uv = geom.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) {
      let u = uv.getX(i);
      let v = uv.getY(i);
      const overlap = (faceIdx % 2 === 0) 
        ? 1 - 1/22  // 120° faces  
        : 1 - 1/12; // 60° faces
      u *= overlap;
      uv.setXY(i, u, v);
    }
    uv.needsUpdate = true;
  }

  __setTopBottomUV(geom, faceIdx) {
    if (faceIdx < 4) return;

    const uv = geom.getAttribute("uv");
    const position = geom.getAttribute("position")
    const largestX =
      faceIdx == 4 ? position.getX(position.count - 1) : position.getX(0);
    for (let i = 0; i < uv.count; i++) {
      let u = position.getX(i);
      let v = position.getZ(i);
      u =
        i == 4
          ?  u / (2 *  largestX) + 0.5
          : (u / (2 * -largestX) + 0.5);
      v = v / (2 * largestX) + 0.5;
      uv.setXY(i, u, v);
    }
    uv.needsUpdate = true;
  }

  /**
   * @override
   */
  setTexture(mesh, textureData) {
    for (let i = 0; i < FACES; i++) {
      if (textureData.texture[i]) {
        mesh.material[i] = new THREE.MeshBasicMaterial({
          map: textureData.texture[i],
        });
      }
    }
    this.__refresh(); // immediately replace the low quality tiles from intial load
  }

  /**
   * @override
   */
  setTextureOpacity(mesh, opacity) {
    for (let i = 0; i < FACES; i++) {
      mesh.material[i].opacity = opacity;
      mesh.material[i].transparent = opacity < 1;
    }
  }

  /**
   * @override
   */
  disposeTexture(textureData) {
    textureData.texture?.forEach((texture) => texture.dispose());
  }

  /**
   * @private
   */
  handleEvent(e) {
    switch (e.type) {
      case PhotoSphereViewer.CONSTANTS.EVENTS.BEFORE_ROTATE:
        // the rotate() method of the viewer only fires BEFORE_ROTATE
        // and not POSITION_UPDATED, so I had to restort to handling
        // BEFFORE_ROTATE instead and passing the rotation param from it
        // all the way to __getVisibleFaces()
        this.__refresh(e.args[0]);
        break;
      case PhotoSphereViewer.CONSTANTS.EVENTS.ZOOM_UPDATED:
        this.__refresh();
        break;
    }
  }

  __refresh(position=null) {
    if (!this.mesh) return;
    if (this.mesh.material.length === 0) return;
    if (!this.dynamicLoadingEnabled) return;
    
    const visibleFaces = this.__getVisibleFaces(position);
    // TODO finetune this
    if (this.psv.renderer.prop.vFov < 55) {
      this.__refreshFaces(visibleFaces, 0);
    } else {
      this.__refreshFaces(visibleFaces, 2);
    }
  }

  __refreshFaces(faces, zoom) {
    for (const faceIdx of faces) {
      if (
        this.mesh.material[faceIdx].map &&
        this.mesh.material[faceIdx].map.userData.zoom > zoom &&
        !this.mesh.material[faceIdx].map.userData.refreshing
      ) {
        this.mesh.material[faceIdx].map.userData.refreshing = true;
        const oldUrl = this.mesh.material[faceIdx].map.userData.url;
        this.__loadOneTexture(zoom, faceIdx).then((texture) => {
          if (this.mesh.material[faceIdx].map.userData.url == oldUrl) {
            // ^ dumb temp fix to stop faces from loading in
            // after the user has already navigated to a different one
            this.mesh.material[faceIdx] = new THREE.MeshBasicMaterial({
              map: texture,
            });
            this.mesh.material[faceIdx].map.userData.refreshing = false;
            this.psv.needsUpdate();
          }
        });
      }
    }
  }

  __getVisibleFaces(position=null) {
    const longitude = position?.longitude ?? null;
    this.screenFrustum.update(longitude);

    // TODO find a more elegant way to do this
    const visibleFaces = [];
    for (let meshIdx = 0; meshIdx < this.meshesForFrustum.length; meshIdx++) {
      const mesh = this.meshesForFrustum[meshIdx];
      const position = mesh.geometry.getAttribute("position");
      const step = 20;
      for (let i = 0; i < position.count; i += step) {
        const point = new THREE.Vector3().fromBufferAttribute(position, i);
        if (this.screenFrustum.frustum.containsPoint(point)) {
          visibleFaces.push(meshIdx);
          break;
        }
      }
    }
    return visibleFaces;
  }

}
