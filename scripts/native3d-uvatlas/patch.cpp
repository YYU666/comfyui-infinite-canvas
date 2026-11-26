#include <UVAtlas.h>
#include <fstream>
#include <iostream>
#include <chrono>
#include <cstring>
template<class T>void read(std::ifstream& f,std::vector<T>&v,size_t n){v.resize(n);f.read(reinterpret_cast<char*>(v.data()),n*sizeof(T));}
template<class T>void write(std::ofstream& f,const std::vector<T>&v){f.write(reinterpret_cast<const char*>(v.data()),v.size()*sizeof(T));}
int main(int argc,char**argv){
 if(argc!=3)return 2;using namespace DirectX;std::ifstream in(argv[1],std::ios::binary);uint32_t n[2];in.read((char*)n,8);if(!in||n[0]>200000||n[1]>100000)return 3;
 std::vector<XMFLOAT3>p;std::vector<uint32_t>f,adj;read(in,p,n[0]);read(in,f,n[1]*3);read(in,adj,n[1]*3);if(!in)return 4;
 std::vector<UVAtlasVertex>v;std::vector<uint8_t>ib;std::vector<uint32_t>parts,remap;float stretch=0;size_t charts=0;auto start=std::chrono::steady_clock::now();
 auto cb=[start](float)->HRESULT{return std::chrono::steady_clock::now()-start>std::chrono::minutes(3)?E_ABORT:S_OK;};
 HRESULT hr=UVAtlasCreate(p.data(),p.size(),f.data(),DXGI_FORMAT_R32_UINT,n[1],0,.3f,4096,4096,16,adj.data(),nullptr,nullptr,cb,.01f,UVATLAS_DEFAULT,v,ib,&parts,&remap,&stretch,&charts);
 std::cout<<"HRESULT="<<hr<<" charts="<<charts<<" stretch="<<stretch<<" vertices="<<v.size()<<" seconds="<<std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count()<<std::endl;
 if(FAILED(hr))return 5;
 bool exact=ib.size()==f.size()*4&&remap.size()==v.size();for(size_t i=0;exact&&i<f.size();i++){uint32_t ix;memcpy(&ix,ib.data()+i*4,4);exact=ix<remap.size()&&remap[ix]==f[i];}if(!exact)return 6;
 for(size_t i=0;i<v.size();i++)if(memcmp(&v[i].pos,&p[remap[i]],12))return 7;
 std::ofstream out(argv[2],std::ios::binary);uint32_t h[]={uint32_t(v.size()),n[1],uint32_t(charts)};out.write((char*)h,12);out.write((char*)&stretch,4);
 std::vector<XMFLOAT2>uv;for(auto&x:v)uv.push_back(x.uv);write(out,uv);write(out,ib);write(out,remap);write(out,parts);return out?0:8;
}
